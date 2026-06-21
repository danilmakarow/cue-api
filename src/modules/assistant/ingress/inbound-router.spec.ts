import {
  ASK_CALLBACK_PREFIX,
  STOP_CALLBACK_PREFIX,
  classifyFlow,
} from './inbound-router';
import {
  KeyboardAction,
  KEYBOARD_LABELS,
  KeyboardSurface,
} from '../reply/reply-keyboard.layout';
import { ActiveKeyboardReadPort } from '../session/active-keyboard.store';
import { PendingInteractionStore } from '../session/pending-interaction.store';
import { User } from '@/modules/database/entities';
import {
  InboundKind,
  NormalizedInboundMessage,
} from '@/modules/external-vendor/external-vendor.types';

const USER = { id: 'user-1', timezone: 'UTC' } as User;

/**
 * Builds a {@link PendingInteractionStore} stub whose `hasPendingQuestion`
 * resolves the given value (default false — this wave never creates a question).
 */
const buildPendingStore = (
  hasPending = false,
): jest.Mocked<PendingInteractionStore> => ({
  hasPendingQuestion: jest.fn().mockResolvedValue(hasPending),
});

/**
 * Builds an {@link ActiveKeyboardReadPort} stub whose `getActiveSurface` resolves
 * the given surface (default null — NO keyboard is the active surface, so a typed
 * label is never hijacked as a keyboard action).
 */
const buildActiveKeyboardStore = (
  surface: KeyboardSurface | null = null,
): jest.Mocked<ActiveKeyboardReadPort> => ({
  getActiveSurface: jest.fn().mockResolvedValue(surface),
});

/**
 * Overlays the given fields onto a minimal normalized message, defaulting the
 * vendor identity/dedupe fields every kind carries.
 */
const normalize = (
  over: Partial<NormalizedInboundMessage> & { kind: InboundKind },
): NormalizedInboundMessage => ({
  vendorChatId: 'chat-1',
  vendorUserId: 'u-1',
  dedupeId: '1',
  ...over,
});

describe('classifyFlow (inbound router taxonomy)', () => {
  it('classifies a slash command as CommandFlow (no LLM), carrying name + args', async () => {
    const flow = await classifyFlow(
      normalize({
        kind: InboundKind.Command,
        command: 'today',
        commandArgs: ['extra'],
      }),
      USER,
      buildPendingStore(),
      buildActiveKeyboardStore(),
    );

    expect(flow).toEqual({
      kind: 'command',
      command: 'today',
      args: ['extra'],
    });
  });

  it('defaults command args to an empty array when none are present', async () => {
    const flow = await classifyFlow(
      normalize({ kind: InboundKind.Command, command: 'help' }),
      USER,
      buildPendingStore(),
      buildActiveKeyboardStore(),
    );

    expect(flow).toMatchObject({ kind: 'command', args: [] });
  });

  it('classifies an ask: callback as AnswerFlow from a button (re-invoke path; Story-5-only at the wire)', async () => {
    const callbackData = `${ASK_CALLBACK_PREFIX}row-id:opt2`;
    const flow = await classifyFlow(
      normalize({
        kind: InboundKind.Callback,
        callbackId: 'cb-3',
        callbackData,
      }),
      USER,
      buildPendingStore(),
      buildActiveKeyboardStore(),
    );

    expect(flow).toMatchObject({
      kind: 'answer',
      source: 'callback',
      callbackId: 'cb-3',
      callbackData,
    });
  });

  it('classifies a stop: callback as StopControlFlow (Story 14b, deterministic), carrying the turn id', async () => {
    const flow = await classifyFlow(
      normalize({
        kind: InboundKind.Callback,
        callbackId: 'cb-stop',
        callbackData: `${STOP_CALLBACK_PREFIX}turn-xyz`,
      }),
      USER,
      buildPendingStore(),
      buildActiveKeyboardStore(),
    );

    expect(flow).toEqual({
      kind: 'stop_control',
      callbackId: 'cb-stop',
      turnId: 'turn-xyz',
    });
  });

  it('keeps the stop: and ask: prefixes disjoint so a STOP tap is never any other flow', async () => {
    expect(STOP_CALLBACK_PREFIX.startsWith(ASK_CALLBACK_PREFIX)).toBe(false);
    expect(ASK_CALLBACK_PREFIX.startsWith(STOP_CALLBACK_PREFIX)).toBe(false);

    const stopFlow = await classifyFlow(
      normalize({
        kind: InboundKind.Callback,
        callbackId: 'cb-s',
        callbackData: `${STOP_CALLBACK_PREFIX}t`,
      }),
      USER,
      buildPendingStore(true), // even with a pending question, a stop: tap is STOP
      buildActiveKeyboardStore(),
    );

    expect(stopFlow.kind).toBe('stop_control');
  });

  it('classifies a plain text message with NO pending question as SimpleMessageFlow (fresh turn)', async () => {
    const store = buildPendingStore(false);
    const flow = await classifyFlow(
      normalize({ kind: InboundKind.Text, text: 'what is on tomorrow?' }),
      USER,
      store,
      buildActiveKeyboardStore(),
    );

    expect(flow).toEqual({
      kind: 'simple_message',
      text: 'what is on tomorrow?',
      contentType: InboundKind.Text,
    });
    // The gate WAS consulted (cheap EXISTS), and returned false this wave.
    expect(store.hasPendingQuestion).toHaveBeenCalledWith('user-1');
  });

  it('routes free text to AnswerFlow when a pending question exists (the Story-5 gate)', async () => {
    // Today hasPendingQuestion always resolves false; here we force true to prove
    // the gate is real and wired, so Story 5's write side flips it on for free.
    const store = buildPendingStore(true);
    const flow = await classifyFlow(
      normalize({ kind: InboundKind.Text, text: 'actually, Friday' }),
      USER,
      store,
      buildActiveKeyboardStore(),
    );

    expect(flow).toMatchObject({
      kind: 'answer',
      source: 'text',
      text: 'actually, Friday',
      contentType: InboundKind.Text,
    });
  });

  it('treats free text as a FRESH turn once the hot window lapses (gate false) — never a stale silent answer', async () => {
    // ADR 0010: after the Redis hot window (TTL) lapses, hasPendingQuestion is
    // false, so a typed message is a fresh SimpleMessageFlow — never silently
    // consumed as an answer to a question the user may have abandoned.
    const store = buildPendingStore(false);
    const flow = await classifyFlow(
      normalize({ kind: InboundKind.Text, text: 'hello' }),
      USER,
      store,
      buildActiveKeyboardStore(),
    );

    expect(flow.kind).toBe('simple_message');
  });

  it('routes an ask: button to AnswerFlow WITHOUT consulting the hot window — a button resumes after the TTL', async () => {
    // ADR 0010: a button carries the durable row id, so it resumes from Postgres
    // even after the Redis hot window lapsed. The router must classify it as an
    // answer purely on the `ask:` prefix, never gating it on hasPendingQuestion.
    const store = buildPendingStore(false);
    const flow = await classifyFlow(
      normalize({
        kind: InboundKind.Callback,
        callbackId: 'cb-late',
        callbackData: `${ASK_CALLBACK_PREFIX}pq-old:fri`,
      }),
      USER,
      store,
      buildActiveKeyboardStore(),
    );

    expect(flow).toMatchObject({ kind: 'answer', source: 'callback' });
    expect(store.hasPendingQuestion).not.toHaveBeenCalled();
  });

  it('classifies a voice note by its transcript (simple message when no pending question)', async () => {
    const flow = await classifyFlow(
      normalize({
        kind: InboundKind.Voice,
        media: { vendorFileId: 'file-1' },
      }),
      USER,
      buildPendingStore(false),
      buildActiveKeyboardStore(),
      'move my 3pm to 4',
    );

    expect(flow).toEqual({
      kind: 'simple_message',
      text: 'move my 3pm to 4',
      contentType: InboundKind.Voice,
    });
  });

  it('routes a voice transcript to AnswerFlow when a question is pending', async () => {
    const flow = await classifyFlow(
      normalize({
        kind: InboundKind.Voice,
        media: { vendorFileId: 'file-2' },
      }),
      USER,
      buildPendingStore(true),
      buildActiveKeyboardStore(),
      'Friday works',
    );

    expect(flow).toMatchObject({
      kind: 'answer',
      source: 'text',
      text: 'Friday works',
      contentType: InboundKind.Voice,
    });
  });

  // --- Story 16: reply-keyboard taps (text-equality, gated on the active surface) ---

  it('routes a typed label to KeyboardActionFlow ONLY when the matching keyboard is the active surface', async () => {
    const keyboard = buildActiveKeyboardStore(KeyboardSurface.Main);
    const flow = await classifyFlow(
      normalize({
        kind: InboundKind.Text,
        text: KEYBOARD_LABELS.todaySchedule,
      }),
      USER,
      buildPendingStore(false),
      keyboard,
    );

    expect(flow).toEqual({
      kind: 'keyboard_action',
      action: KeyboardAction.TodaySchedule,
    });
    expect(keyboard.getActiveSurface).toHaveBeenCalledWith('user-1');
  });

  it('does NOT hijack a literally-typed "Settings" when NO keyboard is the active surface (default null) — it is a fresh turn', async () => {
    const keyboard = buildActiveKeyboardStore(null);
    const flow = await classifyFlow(
      normalize({ kind: InboundKind.Text, text: KEYBOARD_LABELS.settings }),
      USER,
      buildPendingStore(false),
      keyboard,
    );

    // The exact button label, but with no active surface it is plain conversation.
    expect(flow).toEqual({
      kind: 'simple_message',
      text: 'Settings',
      contentType: InboundKind.Text,
    });
  });

  it('does NOT route a label the DOCKED surface does not own (e.g. "Back" while the main keyboard is active) — fresh turn', async () => {
    const keyboard = buildActiveKeyboardStore(KeyboardSurface.Main);
    const flow = await classifyFlow(
      normalize({ kind: InboundKind.Text, text: KEYBOARD_LABELS.back }),
      USER,
      buildPendingStore(false),
      keyboard,
    );

    // "Back" only exists on the settings surface; with main docked it is inert.
    expect(flow.kind).toBe('simple_message');
  });

  it('routes the settings-surface labels only when the settings keyboard is active', async () => {
    const keyboard = buildActiveKeyboardStore(KeyboardSurface.Settings);
    const disconnect = await classifyFlow(
      normalize({ kind: InboundKind.Text, text: KEYBOARD_LABELS.disconnect }),
      USER,
      buildPendingStore(false),
      keyboard,
    );
    const back = await classifyFlow(
      normalize({ kind: InboundKind.Text, text: KEYBOARD_LABELS.back }),
      USER,
      buildPendingStore(false),
      keyboard,
    );

    expect(disconnect).toEqual({
      kind: 'keyboard_action',
      action: KeyboardAction.Disconnect,
    });
    expect(back).toEqual({
      kind: 'keyboard_action',
      action: KeyboardAction.Back,
    });
  });

  it('a keyboard tap takes precedence over a pending question — it is never consumed as a free-text answer', async () => {
    const pending = buildPendingStore(true);
    const flow = await classifyFlow(
      normalize({ kind: InboundKind.Text, text: KEYBOARD_LABELS.nextWeek }),
      USER,
      pending,
      buildActiveKeyboardStore(KeyboardSurface.Main),
    );

    expect(flow).toEqual({
      kind: 'keyboard_action',
      action: KeyboardAction.NextWeek,
    });
    // The deterministic keyboard tap short-circuits before the pending-question gate.
    expect(pending.hasPendingQuestion).not.toHaveBeenCalled();
  });

  it('a VOICE transcript that happens to equal a label is NEVER a keyboard tap (only typed text echoes a label)', async () => {
    const keyboard = buildActiveKeyboardStore(KeyboardSurface.Main);
    const flow = await classifyFlow(
      normalize({
        kind: InboundKind.Voice,
        media: { vendorFileId: 'file-3' },
      }),
      USER,
      buildPendingStore(false),
      keyboard,
      KEYBOARD_LABELS.todaySchedule,
    );

    expect(flow).toMatchObject({
      kind: 'simple_message',
      contentType: InboundKind.Voice,
    });
    // The active-surface lookup is never even consulted for a voice transcript.
    expect(keyboard.getActiveSurface).not.toHaveBeenCalled();
  });
});
