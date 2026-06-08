/**
 * Internal types for the assistant module — the BullMQ job payloads, the held
 * conflict record, and the tool-dispatch context. Vendor/AI/STT DTOs live in
 * their connector modules and are imported where needed; nothing here leaks a
 * vendor wire shape.
 */

import { HandleMap } from './tools/handle-map';
import { User } from '@/modules/database/entities';
import { ExternalVendor } from '@/modules/external-vendor/external-vendor.types';

/**
 * The scope a recurring edit (update / delete) resolves to — the three
 * operations from the recurrence-expansion spec. `this` overrides a single
 * occurrence, `this_and_following` splits the series, `all` edits the master.
 * Ignored entirely on a non-recurring task.
 */
export type EditScope = 'this' | 'this_and_following' | 'all';

/**
 * Per-turn context a tool dispatch needs: who the user is (for ownership and
 * timezone) and the per-turn {@link HandleMap} that resolves the bracketed
 * aliases the model addresses tasks by. Built once per user turn by the
 * orchestrator.
 *
 * `handleMap` is optional only so the orchestrator's existing context literal
 * keeps compiling until Task A2 seeds and threads a real map; the dispatcher
 * falls back to a fresh, empty map per call when it is absent (no cross-call
 * handle persistence in that fallback — A2 supplies the shared, seeded map).
 */
export interface ToolDispatchContext {
  userId: string;
  user: User;
  handleMap?: HandleMap;
  /** Turn correlation id, so a tool-dispatch failure log is greppable by turn. */
  correlationId?: string;
}

/**
 * The durable BullMQ job enqueued by the webhook controller and consumed off the
 * request path. Carries everything `handleWebhook` needs plus the receipt time;
 * the BullMQ job id is the vendor dedupe id so duplicate deliveries collapse.
 */
export interface WebhookQueueJob {
  vendor: ExternalVendor;
  /** Caller IP, captured in the request path for audit/abuse tooling. */
  ip: string;
  /** Inbound headers (lowercased keys), needed for vendor-side auth/normalize. */
  headers: Record<string, string | undefined>;
  /** Raw JSON body as received, serialized so it survives Redis round-trips. */
  body: string;
  /** ISO timestamp of when the webhook was received in the request path. */
  receivedAt: string;
  /**
   * Correlation id minted in the request path and threaded controller → queue →
   * consumer → orchestrator, so every log line and persisted tool trace for one
   * update shares a single greppable id.
   */
  correlationId: string;
}

/**
 * Kinds of background, post-turn jobs (ADR 0005 tiers 2 & 3). Run on the cheap
 * model after the reply is sent, never blocking it.
 */
export enum BackgroundJobKind {
  SUMMARIZE = 'summarize',
  EXTRACT_MEMORY = 'extract_memory',
}

/**
 * Payload for a post-turn background job, keyed by the conversation/user it
 * concerns. Both kinds re-read state from the DB, so only ids travel on the job.
 */
export interface BackgroundQueueJob {
  kind: BackgroundJobKind;
  conversationId: string;
  userId: string;
}

/**
 * The proposed action held in Redis when a write conflicts with an existing
 * event (ADR 0006 layer 4). Resolved deterministically by the user's callback
 * tap — never by re-invoking the model.
 */
export interface HeldConflictWrite {
  /** The Cue user this write belongs to. */
  userId: string;
  /** Vendor chat to reply into once resolved. */
  vendorChatId: string;
  /** The write the model proposed, validated and ready to execute on confirm. */
  action: HeldWriteAction;
}

/**
 * The concrete write a {@link HeldConflictWrite} will perform on confirmation.
 * Discriminated by `kind`; today only event creation can be held (the only
 * conflict-producing write in v1), but the shape leaves room for updates.
 */
export type HeldWriteAction =
  | {
      kind: 'create_event';
      calendarId: string;
      title: string;
      startAt: string;
      endAt: string | null;
      timezone: string;
      notes: string | null;
    }
  | {
      kind: 'update_event';
      taskId: string;
      startAt: string;
      endAt: string | null;
    };

/**
 * A batch of held writes stashed in Redis under one callback token. A single
 * turn can produce several conflicting writes (e.g. seven lessons where two
 * overlap); they are confirmed/cancelled together by one button tap rather than
 * abandoning the rest. The shared `vendorChatId` is injected when the batch is
 * stored; `userId` owns every action.
 */
export interface HeldConflictBatch {
  userId: string;
  vendorChatId: string;
  actions: HeldWriteAction[];
}

/** Callback-data verbs sent on inline keyboard buttons for held conflicts. */
export enum ConflictCallbackAction {
  CONFIRM = 'confirm',
  CANCEL = 'cancel',
}

/**
 * One persisted tool-loop step inside a {@link ToolRoundAuditPayload}: the tool
 * the model called, its arguments, the result text fed back, and whether that
 * result was an error or a held (awaiting-confirmation) write. Stored verbatim
 * in `ConversationMessage.toolPayload` for the audit trail.
 */
export interface ToolStepRecord {
  name: string;
  input: Record<string, unknown>;
  resultContent: string;
  isError: boolean;
  held: boolean;
}

/**
 * The structured `toolPayload` of one persisted `role = tool` message: a whole
 * tool-loop round — the model's stop reason, any text it produced alongside the
 * calls, and one {@link ToolStepRecord} per dispatched tool. Makes "what did the
 * assistant actually do on turn X" a single SQL query against `toolPayload`.
 */
export interface ToolRoundAuditPayload {
  correlationId: string;
  round: number;
  stopReason: string;
  assistantText: string | null;
  steps: ToolStepRecord[];
}

/**
 * Outcome of a single dispatched tool call inside the orchestrator loop. The
 * orchestrator turns this into a `ToolResultBlock` for the next model round-trip
 * (or, for a held conflict, ends the turn and asks the user instead).
 */
export interface ToolDispatchOutcome {
  /** Text fed back to the model as the tool result content. */
  content: string;
  /** Marks an error result so the model can recover/clarify (never a raw stack). */
  isError?: boolean;
  /** True when this fetch counted against the schedule-fetch read cap. */
  countsAsScheduleFetch?: boolean;
  /**
   * Present when the tool produced a conflicting write that must be held and
   * confirmed by the user; the orchestrator stops the loop and asks via inline
   * keyboard rather than re-invoking the model.
   */
  heldConflict?: {
    promptText: string;
    write: HeldConflictWrite;
  };
}
