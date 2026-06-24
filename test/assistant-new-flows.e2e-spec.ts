import {
  CapturedSend,
  CapturingVendorConnector,
} from './e2e/capturing-vendor.connector';
import { E2eHarness, SeededFixtures } from './e2e/harness';
import { completion, toolCall } from './e2e/scripted-ai.connector';
import { AiStopReason } from '@/modules/ai/ai.types';
import {
  KEYBOARD_LABELS,
  KeyboardSurface,
  MENU_KEYBOARD,
} from '@/modules/assistant/reply/reply-keyboard.layout';
import {
  RecurrenceEndType,
  RecurrenceFrequency,
} from '@/modules/database/entities';
import {
  OutboundActionButton,
  OutboundFormat,
  ReplyKeyboard,
} from '@/modules/external-vendor/external-vendor.types';

/**
 * Real-request E2E for the WAVE-1 + WAVE-2 surfaces (ADR 0053/0056/0058). Boots
 * the WHOLE app against the local docker Postgres + Redis with the real
 * in-process BullMQ worker, the captured Telegram vendor (real ingress), and the
 * deterministic scripted AI — the same harness the core pipeline e2e uses — and
 * drives the NEW deterministic paths end to end:
 *
 *  (a) the reply-keyboard MENU surface (R4 / ADR 0056): an "Open Menu" tap docks
 *      the MENU_KEYBOARD + a connection-status card, and a second tap dedup-DELETES
 *      the prior card rather than duplicating it.
 *  (b) the answered-question BUTTON MORPH (R3 / ADR 0058): an `ask_user` turn, then
 *      the inline-button callback edits the ORIGINAL question message — buttons
 *      cleared, a localized "User selected: <label>" line appended — and the resume
 *      still opens its own loader.
 *  (c) inline recurrence via the AI tool (ADR 0054): `create_task` / `update_task`
 *      carrying a recurrence config + color + requiresCompletion persists as a
 *      `recurrenceConfig` JSONB column with NO `recurrence_rule` row, and the
 *      effective-settings resolver surfaces it.
 *
 * No real LLM is needed — every path is driven through the scripted connector. The
 * token-STREAMING wiring is asserted deterministically (the loader frame precedes
 * the morph); real streamed deltas are an opt-in manual smoke (E2E_LLM=real), so
 * the user's Anthropic budget is never spent autonomously here.
 */
describe('Assistant new flows (real-request e2e): menu, button-morph, inline recurrence', () => {
  let harness: E2eHarness;
  let fixtures: SeededFixtures;

  beforeAll(async () => {
    harness = await E2eHarness.boot();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    fixtures = await harness.seedLinkedUser();
  });

  afterEach(async () => {
    await harness.settleBackground();
    await harness.reset();
  });

  /** Reads the text off a captured reply (the morph `editMessageText`, ADR 0053). */
  const replyTextOf = (send: CapturedSend): string =>
    (send.payload as { text: string }).text;

  /** Reads the reply-keyboard markup off a captured `sendMessageWithKeyboard`. */
  const keyboardOf = (send: CapturedSend): ReplyKeyboard =>
    (send.payload as { replyKeyboard: ReplyKeyboard }).replyKeyboard;

  /** Flattens a reply keyboard's button labels for an order-insensitive compare. */
  const labelsOf = (keyboard: ReplyKeyboard): string[] =>
    keyboard.buttons.flat().map((button) => button.label);

  /** Reads the inline-button rows off an `ask_user` morph / fresh keyboard send. */
  const buttonsOf = (send: CapturedSend): OutboundActionButton[][] =>
    (send.payload as { buttons: OutboundActionButton[][] }).buttons;

  /**
   * Per-round recaps morph the live status line as an HTML `<pre>` code block (R1
   * / ADR 0057), and the capturing vendor treats any `format === Html` edit as
   * substantive — so a multi-round turn surfaces one or more `<pre>…</pre>` recap
   * frames on `nextSend()` BEFORE the final answer morph. This drains those status
   * frames and resolves with the FIRST substantive `editMessageText` that is NOT a
   * `<pre>` recap frame — i.e. the turn's real answer morph (the model's text is
   * HTML-converted but never wrapped in `<pre>`). Bounded by jest's testTimeout.
   */
  const nextAnswerMorph = async (): Promise<CapturedSend> => {
    let send = await harness.vendor.nextSend();

    while (
      send.method === 'editMessageText' &&
      /^<pre>[\s\S]*<\/pre>$/.test(replyTextOf(send))
    ) {
      send = await harness.vendor.nextSend();
    }

    return send;
  };

  describe('(a) reply-keyboard Menu surface (R4 / ADR 0056)', () => {
    it('docks the MENU_KEYBOARD with a connection-status card on the first Open Menu tap', async () => {
      // The Menu tap is a PLAIN-TEXT tap of the "Open Menu" label; it only routes
      // as a keyboard action when a keyboard is the active surface. Dock the MAIN
      // surface first (it owns "Open Menu" globally, R4) so the tap is classified
      // deterministically rather than fed to the model.
      await harness.setActiveKeyboardSurface(
        fixtures.user.id,
        KeyboardSurface.Main,
      );

      await harness.postWebhook(
        harness.buildTextUpdate(fixtures.chatId, KEYBOARD_LABELS.openMenu),
      );

      const menu = await harness.vendor.nextSend();

      // The menu is a docked reply keyboard (NOT a model morph): a
      // sendMessageWithKeyboard carrying the MENU_KEYBOARD markup.
      expect(menu.method).toBe('sendMessageWithKeyboard');
      expect(menu.target).toEqual({ vendorChatId: fixtures.chatId });
      expect(labelsOf(keyboardOf(menu)).sort()).toEqual(
        labelsOf(MENU_KEYBOARD).sort(),
      );

      // The card carries the connection-status line — this user is LINKED (the
      // harness seeded a TelegramLink), so it is the connected marker.
      expect(replyTextOf(menu)).toMatch(/Connected/i);
      expect(replyTextOf(menu)).toMatch(/Menu/);

      // First open: nothing to dedup-delete yet (no prior menu card).
      const deletes = harness.vendor.sends.filter(
        (send) => send.method === 'deleteMessage',
      );

      expect(deletes).toHaveLength(0);
    });

    it('dedup-DELETES the prior menu card on the second Open Menu tap (no duplicate)', async () => {
      await harness.setActiveKeyboardSurface(
        fixtures.user.id,
        KeyboardSurface.Main,
      );

      // First open — capture the docked card's vendor message id.
      await harness.postWebhook(
        harness.buildTextUpdate(fixtures.chatId, KEYBOARD_LABELS.openMenu),
      );

      const firstMenu = await harness.vendor.nextSend();

      expect(firstMenu.method).toBe('sendMessageWithKeyboard');

      // Let the openMenu handler finish recording the menu-card id in Redis before
      // the second tap reads it for the dedup-delete (the record runs after the send).
      await harness.settleBackground();

      // Second open — a fresh card is sent (send-new-FIRST) AND the prior one is
      // retired (delete-old-AFTER), so the chat never accumulates stale menu cards.
      await harness.postWebhook(
        harness.buildTextUpdate(fixtures.chatId, KEYBOARD_LABELS.openMenu),
      );

      const secondMenu = await harness.vendor.nextSend();

      expect(secondMenu.method).toBe('sendMessageWithKeyboard');
      expect(labelsOf(keyboardOf(secondMenu)).sort()).toEqual(
        labelsOf(MENU_KEYBOARD).sort(),
      );

      // The dedup-delete is framing (recorded, never a terminal send), so settle
      // the tail before inspecting the capture log.
      await harness.settleBackground();

      // EXACTLY one delete fired across the whole scenario — the first card retired
      // when the second opened. Two cards were sent, one was deleted: net one card.
      const sends = harness.vendor.sends;
      const keyboardSends = sends.filter(
        (send) => send.method === 'sendMessageWithKeyboard',
      );
      const deletes = sends.filter((send) => send.method === 'deleteMessage');

      expect(keyboardSends).toHaveLength(2);
      expect(deletes).toHaveLength(1);
    });
  });

  describe('(b) answered-question button morph (R3 / ADR 0058)', () => {
    it('edits the original question (buttons cleared + "User selected:" appended) on the button tap, and the resume opens its own loader', async () => {
      // Round 1: the model asks a clarifying question with two tappable options;
      // the turn SUSPENDS (a pending_question row + the inline keyboard morph).
      harness.scriptedAi.script([
        completion({
          stopReason: AiStopReason.TOOL_USE,
          toolCalls: [
            toolCall('ask_user', {
              question: 'Which day should I book it?',
              options: [
                { id: 'fri', label: 'Friday' },
                { id: 'sat', label: 'Saturday' },
              ],
            }),
          ],
        }),
      ]);

      await harness.postWebhook(
        harness.buildTextUpdate(fixtures.chatId, 'book me a slot sometime'),
      );

      const ask = await harness.vendor.nextSend();

      // The question morphs the loading line: an editMessageText carrying buttons.
      expect(ask.method).toBe('editMessageText');

      const askButtons = buttonsOf(ask);

      expect(askButtons[0][0].label).toBe('Friday');

      const pending = await harness.listPendingQuestions();

      expect(pending).toHaveLength(1);

      const fridayCallback = askButtons[0][0].callbackData;

      expect(fridayCallback).toBe(`ask:${pending[0].id}:fri`);

      // Count the sends so far so we can isolate the resume's NEW sends below.
      const sendsBeforeResume = harness.vendor.sends.length;

      // Resume: the user taps "Friday". Script the continued turn (create + confirm)
      // so the resume re-invokes the model and produces a reply.
      harness.scriptedAi.script([
        completion({
          stopReason: AiStopReason.TOOL_USE,
          toolCalls: [
            toolCall('create_task', {
              title: 'Booked slot',
              startAt: '2026-07-03T15:00:00.000Z',
              endAt: '2026-07-03T16:00:00.000Z',
            }),
          ],
        }),
        completion({
          stopReason: AiStopReason.END_TURN,
          text: 'Done — booked your slot for Friday.',
        }),
      ]);

      await harness.postWebhook(
        harness.buildCallbackUpdate(fixtures.chatId, fridayCallback),
      );

      // Drain to the resume's TERMINAL ANSWER morph specifically — the continued
      // turn's confirmation ("Done — booked your slot for Friday."). This must NOT
      // be the answered-question morph (which ALSO contains "Friday") nor a `<pre>`
      // recap frame, so it is identified by the answer text AND the absence of the
      // clearButtons flag. Draining to the real answer (rather than the first edit)
      // guarantees the resumed create_task has committed before the DB assertion.
      let resumeAnswer = await harness.vendor.nextSend();

      while (
        resumeAnswer.method !== 'editMessageText' ||
        (resumeAnswer.payload as { clearButtons?: boolean }).clearButtons ===
          true ||
        !/booked your slot/i.test(replyTextOf(resumeAnswer))
      ) {
        resumeAnswer = await harness.vendor.nextSend();
      }

      expect(replyTextOf(resumeAnswer)).toMatch(/booked your slot for friday/i);

      await harness.settleBackground();

      // The NEW sends produced by the resume (everything after the suspend).
      const resumeSends = harness.vendor.sends.slice(sendsBeforeResume);

      // FEATURE 1 — the answered-question morph: the ORIGINAL question message was
      // edited in place. It is an HTML editMessageText that CLEARS the buttons
      // (empty inline_keyboard via clearButtons) and appends the localized
      // "User selected: <label>" line. Distinguish it from the resume's own answer
      // morph by clearButtons === true.
      const answeredMorph = resumeSends.find(
        (send) =>
          send.method === 'editMessageText' &&
          (send.payload as { clearButtons?: boolean }).clearButtons === true,
      );

      expect(answeredMorph).toBeDefined();

      const morphPayload = answeredMorph!.payload as {
        text: string;
        format?: OutboundFormat;
        clearButtons?: boolean;
        buttons?: OutboundActionButton[][];
      };

      // Buttons cleared (no inline keyboard attached, the clear flag set) so the
      // card can no longer be tapped.
      expect(morphPayload.clearButtons).toBe(true);
      expect(morphPayload.buttons).toBeUndefined();
      expect(morphPayload.format).toBe(OutboundFormat.Html);

      // Localized "User selected: Friday" line appended below the original question
      // (English locale — the question was authored in English).
      expect(morphPayload.text).toMatch(/Which day should I book it\?/);
      expect(morphPayload.text).toMatch(/User selected:\s*Friday/);

      // FEATURE 2 — the resume still opens its OWN loader: a fresh status
      // `sendMessage` (the loading line) precedes the resume's answer morph, so the
      // continued turn is not silent mid-flight.
      const resumeLoader = resumeSends.find(
        (send) => send.method === 'sendMessage',
      );

      expect(resumeLoader).toBeDefined();

      // The task the resumed model created actually committed.
      const tasks = await harness.listTasks(fixtures.calendar.id);

      expect(tasks.map((task) => task.title)).toEqual(['Booked slot']);

      // The pending question was claimed exactly once (ANSWERED) — the morph fired
      // on the single winning claim.
      const pendingAfter = await harness.listPendingQuestions();

      expect(pendingAfter[0].status).toBe('ANSWERED');
    });
  });

  describe('(c) inline recurrence + effective settings via AI tools (ADR 0054)', () => {
    it('create_task with recurrence + color + requiresCompletion persists recurrenceConfig JSONB (no recurrence_rule row) and the resolver surfaces it', async () => {
      // The recurrence_rule table was dropped by the wipe migration — recurrence is
      // now inline JSONB, so a recurring create can never produce a rule row.
      expect(await harness.tableExists('recurrence_rule')).toBe(false);

      // Round 1: create a WEEKLY-on-Mondays recurring task carrying an explicit
      // color + requiresCompletion. Round 2: confirm.
      harness.scriptedAi.script([
        completion({
          stopReason: AiStopReason.TOOL_USE,
          toolCalls: [
            toolCall('create_task', {
              title: 'Team standup',
              startAt: '2026-07-06T09:00:00.000Z',
              endAt: '2026-07-06T09:15:00.000Z',
              timezone: 'UTC',
              requiresCompletion: true,
              color: 'BLUE',
              recurrence: {
                frequency: RecurrenceFrequency.WEEKLY,
                interval: 1,
                byWeekday: [0],
                endType: RecurrenceEndType.NEVER,
              },
            }),
          ],
        }),
        completion({
          stopReason: AiStopReason.END_TURN,
          text: 'Done — your weekly standup repeats every Monday.',
        }),
      ]);

      await harness.postWebhook(
        harness.buildTextUpdate(
          fixtures.chatId,
          'add a weekly standup every Monday at 9, blue, must be completed',
        ),
      );

      const reply = await nextAnswerMorph();

      expect(reply.method).toBe('editMessageText');
      expect(replyTextOf(reply)).toMatch(/weekly|monday|standup/i);

      // The write committed inline: exactly one task row carrying the recurrence
      // config as JSONB plus the color + requiresCompletion columns (ADR 0054).
      const rows = await harness.listTaskSettings(fixtures.calendar.id);

      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe('Team standup');
      expect(rows[0].color).toBe('BLUE');
      expect(rows[0].requiresCompletion).toBe(true);

      expect(rows[0].recurrenceConfig).not.toBeNull();
      expect(rows[0].recurrenceConfig).toMatchObject({
        frequency: RecurrenceFrequency.WEEKLY,
        interval: 1,
        byWeekday: [0],
        endType: RecurrenceEndType.NEVER,
      });

      // No recurrence_rule table → no rule row possible; the JSONB column IS the
      // single source the expansion engine + effective resolver read.
      expect(await harness.tableExists('recurrence_rule')).toBe(false);

      // The effective-settings resolver surfaces the inline config + color +
      // requiresCompletion as the task's effective values (task-wins, ADR 0054).
      const effective = await harness.resolveEffectiveForFirstTask(
        fixtures.calendar.id,
      );

      expect(effective.recurrence).toMatchObject({
        frequency: RecurrenceFrequency.WEEKLY,
        byWeekday: [0],
      });
      expect(effective.requiresCompletion).toBe(true);
      expect(effective.color).toBe('BLUE');
    });

    it('update_task can attach a recurrence config + color to a one-off task (inline, resolver-surfaced)', async () => {
      // Round 1: create a plain one-off todo (no recurrence). Round 2: list it so
      // the model gets a handle. Round 3: update it to recur MONTHLY with a color.
      // Round 4: confirm.
      harness.scriptedAi.script([
        completion({
          stopReason: AiStopReason.TOOL_USE,
          toolCalls: [
            toolCall('create_task', {
              title: 'Pay rent',
              startAt: '2026-07-01T08:00:00.000Z',
              endAt: '2026-07-01T08:30:00.000Z',
              timezone: 'UTC',
            }),
          ],
        }),
        completion({
          stopReason: AiStopReason.TOOL_USE,
          toolCalls: [
            toolCall('list_tasks', {
              from: '2026-07-01T00:00:00.000Z',
              to: '2026-07-02T00:00:00.000Z',
            }),
          ],
        }),
        completion({
          stopReason: AiStopReason.TOOL_USE,
          toolCalls: [
            toolCall('update_task', {
              handle: 'e1',
              color: 'RED',
              recurrence: {
                frequency: RecurrenceFrequency.MONTHLY,
                interval: 1,
                byMonthDay: [1],
                endType: RecurrenceEndType.NEVER,
              },
            }),
          ],
        }),
        completion({
          stopReason: AiStopReason.END_TURN,
          text: 'Done — rent now repeats on the 1st of every month.',
        }),
      ]);

      await harness.postWebhook(
        harness.buildTextUpdate(
          fixtures.chatId,
          'make my rent task repeat monthly on the 1st and color it red',
        ),
      );

      const reply = await nextAnswerMorph();

      expect(reply.method).toBe('editMessageText');
      expect(replyTextOf(reply)).toMatch(/month|rent/i);

      // The single task now carries an inline MONTHLY recurrenceConfig + the RED
      // color, set through the AI update path — still no rule row anywhere.
      const rows = await harness.listTaskSettings(fixtures.calendar.id);

      expect(rows).toHaveLength(1);
      expect(rows[0].color).toBe('RED');
      expect(rows[0].recurrenceConfig).toMatchObject({
        frequency: RecurrenceFrequency.MONTHLY,
        byMonthDay: [1],
      });

      expect(await harness.tableExists('recurrence_rule')).toBe(false);

      const effective = await harness.resolveEffectiveForFirstTask(
        fixtures.calendar.id,
      );

      expect(effective.recurrence).toMatchObject({
        frequency: RecurrenceFrequency.MONTHLY,
        byMonthDay: [1],
      });
      expect(effective.color).toBe('RED');
    });
  });
});
