import { CapturedSend } from './e2e/capturing-vendor.connector';
import { E2eHarness, SeededFixtures, TelegramTextUpdate } from './e2e/harness';
import { completion, toolCall } from './e2e/scripted-ai.connector';
import { AiStopReason } from '@/modules/ai/ai.types';
import {
  MessageDraft,
  OutboundFormat,
  OutboundMessage,
} from '@/modules/external-vendor/external-vendor.types';

/**
 * Real-request E2E for the ADR 0059 draft-streaming surface. Boots the WHOLE app
 * against the local docker Postgres + Redis with the in-process BullMQ worker, the
 * captured Telegram vendor (real ingress), and the deterministic scripted AI — the
 * same harness the core pipeline e2e uses — and asserts the live-status SURFACE per
 * chat kind:
 *
 *  - PRIVATE chats drive an ephemeral native draft (`sendMessageDraft`): a rotating
 *    loading word (plain text) → the BARE recap text shown ALONE (no `<blockquote>`,
 *    no `<pre>`, no word line above it, ADR 0059) → the answer is FINALISED by a
 *    fresh real `sendMessage` (NOT an `editMessageText` morph). The draft
 *    self-expires; there is no morph and no clear.
 *  - NON-PRIVATE chats keep the ADR 0053 fallback: ONE real status message edited in
 *    place and MORPHED into the answer via `editMessageText` (no draft at all).
 *
 * Unlike the morph-era specs, the terminal reply on the private path is a fresh
 * `sendMessage`, which the capturing vendor records as FRAMING (it never resolves a
 * `nextSend()` waiter). So this spec drives the turn to quiescence via
 * `settleBackground()` and asserts directly on the ordered `vendor.sends` capture
 * log, rather than awaiting the (morph-only) terminal-send seam.
 */
describe('Assistant draft streaming (real-request e2e): native drafts vs morph fallback (ADR 0059)', () => {
  let harness: E2eHarness;

  beforeAll(async () => {
    harness = await E2eHarness.boot();
  });

  afterAll(async () => {
    await harness.close();
  });

  afterEach(async () => {
    await harness.settleBackground();
    await harness.reset();
  });

  /** Reads the text off any captured send whose payload carries a `.text`. */
  const textOf = (send: CapturedSend): string =>
    (send.payload as { text: string }).text;

  /** The drafts (`sendMessageDraft`) captured so far, in dispatch order. */
  const draftSends = (): CapturedSend[] =>
    harness.vendor.sends.filter((send) => send.method === 'sendMessageDraft');

  /** The real `sendMessage` sends captured so far, in dispatch order. */
  const messageSends = (): CapturedSend[] =>
    harness.vendor.sends.filter((send) => send.method === 'sendMessage');

  /**
   * Polls the captured-send log until `predicate` holds or the budget elapses, so
   * the test waits for the async worker turn WITHOUT relying on the morph-only
   * `nextSend()` seam (the private terminal reply is a framing `sendMessage`).
   * Bounded well under jest's `testTimeout`; throws on exhaustion so a stuck turn
   * surfaces as a clear failure rather than a silent pass.
   */
  const waitForSends = async (
    predicate: () => boolean,
    label: string,
  ): Promise<void> => {
    const deadline = Date.now() + 20_000;

    while (Date.now() < deadline) {
      if (predicate()) {
        return;
      }

      await harness.settleBackground();
    }

    throw new Error(`waitForSends timed out waiting for: ${label}`);
  };

  /**
   * Builds a Telegram text update carrying an explicit `chat.type` (e.g. `group`),
   * so the ingress normalizes a NON-PRIVATE chat and the status surface degrades to
   * the `editMessageText` morph. Mirrors the harness's `buildTextUpdate` shape plus
   * the chat-type field the morph fallback gates on (`chat.type` is read by the
   * connector's `normalizeMessage`); the harness's narrower `chat` shape omits it,
   * so the typed `type` field is attached via an intersection before widening to the
   * update type the webhook accepts.
   */
  const buildGroupTextUpdate = (
    chatId: string,
    text: string,
  ): TelegramTextUpdate => {
    const numericChatId = Number(chatId);

    return {
      update_id: Date.now(),
      message: {
        message_id: Date.now(),
        chat: { id: numericChatId, type: 'group' } as { id: number },
        from: { id: numericChatId },
        text,
      },
    };
  };

  describe('private chat — native draft lifecycle', () => {
    it('streams a recap blockquote draft then finalises with a fresh real sendMessage (no editMessageText morph)', async () => {
      const fixtures: SeededFixtures = await harness.seedLinkedUser();

      // Two MAIN rounds: a tool round (so a per-round recap renders into the draft
      // blockquote) and the terminal end_turn answer.
      harness.scriptedAi.script([
        completion({
          stopReason: AiStopReason.TOOL_USE,
          toolCalls: [toolCall('create_task', { title: 'buy milk' })],
        }),
        completion({
          stopReason: AiStopReason.END_TURN,
          text: 'Done — added "buy milk" to your list.',
        }),
      ]);

      await harness.postWebhook(
        harness.buildTextUpdate(fixtures.chatId, 'add buy milk'),
      );

      // Drive the turn to quiescence: wait until the terminal real sendMessage (the
      // finalised answer) has landed in the capture log.
      await waitForSends(
        () => messageSends().some((send) => /buy milk/i.test(textOf(send))),
        'the finalised answer sendMessage',
      );
      await harness.settleBackground();

      const drafts = draftSends();
      const messages = messageSends();
      const morphs = harness.vendor.sends.filter(
        (send) => send.method === 'editMessageText',
      );

      // 1) The live surface was a native draft: at least one sendMessageDraft fired,
      //    all targeting this chat, all carrying a stable NON-ZERO draft id.
      expect(drafts.length).toBeGreaterThan(0);

      for (const draft of drafts) {
        const payload = draft.payload as MessageDraft;

        expect(draft.target).toEqual({
          vendorChatId: fixtures.chatId,
          chatType: 'private',
        });
        expect(payload.draftId).toBeGreaterThan(0);
        expect(payload.format).toBe(OutboundFormat.Html);
      }

      // 2) One stable draft id reused across the whole turn (Telegram animates the
      //    diffs natively from same-id re-calls).
      const draftIds = new Set(
        drafts.map((draft) => (draft.payload as MessageDraft).draftId),
      );

      expect(draftIds.size).toBe(1);

      // 3) The per-round recap draft is the BARE recap text ALONE (ADR 0059): NO
      //    `<blockquote>` (nor `<pre>`) wrapper and NO loading word line above it. The
      //    scripted BACKGROUND recap is the canned "Working on it" line, sent as bare
      //    text with its trailing punctuation stripped (Telegram renders the draft
      //    bare). NO draft frame this turn carries a blockquote/pre status wrapper.
      for (const draft of drafts) {
        const { text } = draft.payload as MessageDraft;

        expect(text).not.toContain('<blockquote>');
        expect(text).not.toContain('<pre>');
      }

      const recapDraft = drafts.find(
        (draft) => (draft.payload as MessageDraft).text === 'Working on it',
      );

      expect(recapDraft).toBeDefined();

      const recapText = (recapDraft!.payload as MessageDraft).text;

      // The working draft is EXACTLY the bare recap — no wrapping tags, no word line
      // before it, and no trailing comma/period/ellipsis.
      expect(recapText.trim().length).toBeGreaterThan(0);
      expect(recapText).not.toMatch(/[.,…]$/);

      // 4) The answer was FINALISED by a fresh real sendMessage carrying the answer —
      //    NOT a draft, NOT an editMessageText morph.
      const answer = messages.find((send) => /buy milk/i.test(textOf(send)));

      expect(answer).toBeDefined();
      expect((answer!.payload as OutboundMessage).format).toBe(
        OutboundFormat.Html,
      );

      // The private path NEVER morphs: no editMessageText was issued this turn.
      expect(morphs).toHaveLength(0);

      // The write actually committed through the real pipeline.
      const tasks = await harness.listTasks(fixtures.calendar.id);

      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toBe('buy milk');
    });
  });

  describe('non-private chat — editMessageText morph fallback', () => {
    it('uses the morph (editMessageText) path and never sends a draft', async () => {
      const groupChatId = '777000222';
      const fixtures: SeededFixtures =
        await harness.seedLinkedUser(groupChatId);

      harness.scriptedAi.script([
        completion({
          stopReason: AiStopReason.TOOL_USE,
          toolCalls: [toolCall('create_task', { title: 'group task' })],
        }),
        completion({
          stopReason: AiStopReason.END_TURN,
          text: 'Done — added "group task".',
        }),
      ]);

      await harness.postWebhook(
        buildGroupTextUpdate(groupChatId, 'add group task'),
      );

      // The terminal reply on the non-private path IS a morph editMessageText, which
      // the capturing vendor records as substantive — await it via nextSend().
      let reply = await harness.vendor.nextSend();

      while (
        reply.method !== 'editMessageText' ||
        !/group task/i.test(textOf(reply))
      ) {
        reply = await harness.vendor.nextSend();
      }

      expect(reply.method).toBe('editMessageText');
      expect(textOf(reply)).toMatch(/group task/i);

      await harness.settleBackground();

      // The morph fallback NEVER opens a draft (sendMessageDraft is private-only).
      expect(draftSends()).toHaveLength(0);

      // It posted exactly one real status message (the loading line) up front, then
      // edited it in place — so there is a framing sendMessage AND at least one
      // editMessageText, and the answer arrived as the latter (asserted above).
      expect(messageSends().length).toBeGreaterThan(0);

      const tasks = await harness.listTasks(fixtures.calendar.id);

      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toBe('group task');
    });
  });
});
