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
 * Discriminated by `kind`. Four shapes:
 * - `create_event` — a single one-off create (the original conflict-producing
 *   write).
 * - `update_event` — a single one-off timed move.
 * - `create_recurring_event` — a whole proposed recurring SERIES held as ONE
 *   write because at least one of its occurrences overlaps an existing event
 *   (Story 9); on confirm it is created verbatim with its `recurrence` payload,
 *   bypassing the conflict check (the user chose "book the series anyway").
 * - `update_recurring_event` — a recurring EDIT whose time/recurrence change
 *   introduces an overlap (Story 9); on confirm it re-runs the chosen-scope edit
 *   verbatim, bypassing the check.
 *
 * The recurring shapes carry the full payload the dispatcher resolved so the
 * orchestrator's confirm-time executor needs no re-resolution — it replays the
 * exact `TaskService` call the check would have committed.
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
    }
  | {
      kind: 'create_recurring_event';
      calendarId: string;
      title: string;
      startAt: string;
      endAt: string;
      timezone: string;
      notes: string | null;
      groupId: string | null;
      isAllDay: boolean;
      requiresCompletion: boolean;
      /** The validated rule grammar, serialized as it crossed the dispatcher. */
      recurrence: HeldRecurrence;
    }
  | {
      kind: 'update_recurring_event';
      taskId: string;
      /** The recurring-edit scope the user originally chose. */
      editScope: EditScope;
      /** The occurrence coordinate the edit targets (ISO), for scoped writes. */
      originalStart: string;
      title: string | null;
      startAt: string | null;
      endAt: string | null;
      groupId: string | null;
      /** A rule change carried with the edit, or null when only time changed. */
      recurrence: HeldRecurrence | null;
    };

/**
 * The serialized recurrence rule grammar carried inside a held recurring write.
 * Mirrors `CreateRecurrenceRuleDto` field-for-field (it survives a Redis JSON
 * round-trip), so the executor can pass it straight back to `TaskService`.
 */
export interface HeldRecurrence {
  frequency: string;
  interval?: number;
  byWeekday?: number[];
  byMonthDay?: number[];
  byMonth?: number[];
  endType?: string;
  endDate?: string;
  count?: number;
}

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
 * Why a terminal narration turn was re-driven (ADR 0009), recorded as a logging
 * hint on the audit payload so re-drive frequency is greppable.
 * `claim_without_writes` = the model narrated a mutation but called no tools and
 * committed nothing; `writes_errored` = a write was attempted but all failed.
 * Purely diagnostic — the re-drive trigger itself is STRUCTURAL (zero tools +
 * zero commits + not-a-question), never this lexical hint.
 */
export type CorrectionReason = 'claim_without_writes' | 'writes_errored';

/**
 * The L4-facing port the tool loop (Story 13 / ADR 0041) uses to render progress
 * into the live status surface, WITHOUT the loop knowing about drafts / Redis /
 * the vendor (the loop stays L9-blind). The turn runner supplies a concrete
 * implementation that wraps the per-turn {@link StatusAnimation} (each method
 * routes through the one draft throttle); a turn with no live status passes a
 * no-op sink.
 *
 * **Degrade-never-throw:** every method MUST swallow its own faults. The loop
 * calls them best-effort and never wraps the calls in try/catch — a status fault
 * must never disturb the turn's answer (the webhook queue is `attempts:1`).
 */
export interface TurnStreamSink {
  /**
   * Renders the latest full-text snapshot of the model's streaming answer into
   * the status draft (final round only). Called with the accumulated snapshot per
   * delta; the implementation batches through the draft throttle, so it must
   * tolerate being called far faster than it can send (it coalesces). The draft
   * is ephemeral — the real `sendMessage` finalize still persists the answer.
   */
  streamAnswer(snapshot: string): void;

  /**
   * Renders a one-sentence per-round recap ("what I'm doing now") into the status
   * draft between tool rounds, so the user sees progress. Best-effort and cheap;
   * a missing/empty recap simply leaves the current frame.
   */
  showRecap(recap: string): void;
}

/**
 * The structured `toolPayload` of one persisted `role = tool` message: a whole
 * tool-loop round — the model's stop reason, any text it produced alongside the
 * calls, and one {@link ToolStepRecord} per dispatched tool. Makes "what did the
 * assistant actually do on turn X" a single SQL query against `toolPayload`.
 *
 * `correctionReason` is set only on a re-driven narration round (ADR 0009) so a
 * SQL/log query can measure re-drive frequency before/after the change.
 */
export interface ToolRoundAuditPayload {
  correlationId: string;
  round: number;
  stopReason: string;
  assistantText: string | null;
  steps: ToolStepRecord[];
  correctionReason?: CorrectionReason;
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
   * keyboard rather than re-invoking the model. Used by the single-write tools
   * (`create_task`, `update_task`) — a batch tool reports many via
   * {@link ToolDispatchOutcome.heldConflicts} instead.
   */
  heldConflict?: {
    promptText: string;
    write: HeldConflictWrite;
  };
  /**
   * Present when a BATCH tool (`create_tasks`) produced one or more conflicting
   * writes: every held item is carried so the orchestrator collects them all
   * into the existing batch-hold confirmation alongside the items that did
   * commit. Each entry mirrors the singular {@link heldConflict} shape. The
   * singular and plural fields are mutually exclusive — a single-write tool sets
   * the former, a batch tool the latter.
   */
  heldConflicts?: {
    promptText: string;
    write: HeldConflictWrite;
  }[];
  /**
   * Number of writes a BATCH tool actually committed this call (non-error,
   * non-held). The orchestrator adds this to `committedWrites` so the
   * saved-changes count is accurate; absent for a single-write tool, where the
   * loop falls back to its existing per-call +1 accounting.
   */
  committedCount?: number;
  /**
   * Number of write attempts a BATCH tool made this call (every item it tried to
   * create, committed or held or errored). The orchestrator adds this to
   * `attemptedWrites`; absent for a single-write tool (loop falls back to +1).
   */
  attemptedCount?: number;
  /**
   * Present when the tool is `ask_user` (ADR 0010): the question the model wants
   * to ask and the optional tappable quick-replies. It is a SENTINEL — the tool
   * touches no database; the orchestrator recognizes it, STOPS the loop, and
   * suspends the turn (persists a `pending_question` row + Redis mirror, sends the
   * question), resuming on the user's answer. Disjoint from `heldConflict[s]` (the
   * deterministic ADR-0006 path that never re-invokes the model).
   */
  askUser?: {
    question: string;
    options: AskUserOption[];
  };
}

/**
 * One tappable quick-reply offered alongside an `ask_user` question, normalized
 * out of the tool input. `id` is the stable key echoed on the callback
 * (`ask:<row>:<id>`); `label` is the button text. Capped at four by the tool
 * schema (ADR 0010). Structurally identical to the entity's
 * `PendingQuestionOption`, kept here so the dispatch boundary owns no entity import.
 */
export interface AskUserOption {
  id: string;
  label: string;
}
