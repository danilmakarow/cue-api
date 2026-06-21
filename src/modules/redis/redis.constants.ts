/**
 * Redis key prefixes and the BullMQ queue name used by the assistant. Kept in
 * one place so the controller, consumer, and orchestrator agree on key shapes.
 */

/** BullMQ queue name for accepted inbound webhook jobs. */
export const WEBHOOK_QUEUE_NAME = 'assistant-webhook';

/** Background queue name for post-turn summary + memory-extraction jobs. */
export const BACKGROUND_QUEUE_NAME = 'assistant-background';

/**
 * BullMQ queue name for the per-user debounce-drain job (Story 14a / ADR 0042).
 * A single delayed job per user (stable `jobId`, see {@link debounceJobId}) fires
 * ~2 s after the LAST inbound in a window and drains that user's buffer into one
 * combined turn. Re-arming a window removes+re-adds this job so the timer slides
 * to the latest message; the window's messages live in the Redis buffer (see
 * {@link debounceBufferKey}), never on the job, so a replaced job never drops one.
 */
export const DEBOUNCE_QUEUE_NAME = 'assistant-debounce';

/** Prefix for the at-least-once dedupe guard, keyed by `${vendor}:${dedupeId}`. */
export const DEDUPE_KEY_PREFIX = 'assistant:dedupe';

/** Prefix for single-use link nonces, keyed by the nonce string. */
export const LINK_NONCE_KEY_PREFIX = 'assistant:link';

/**
 * Prefix for the hot pointer to a suspended `ask_user` question, keyed by the
 * Cue user id. Its mere presence is the cheap `EXISTS` signal the inbound router
 * uses to send a free-text reply into the answer flow while a question is open;
 * its VALUE is the durable `pending_question` row id, so the free-text resolve
 * `GETDEL`s the key (atomic claim of the hot window) and then claims that exact
 * row in Postgres. Disjoint keyspace from the lock / status / debounce keys so
 * the two suspend/resume paths never collide — see
 * `docs/specs/assistant-layered-architecture.md`. Set by Story 5 when an
 * `ask_user` turn suspends (TTL `ASSISTANT_ASK_USER_TTL_SECONDS`) and cleared on
 * claim; after it lapses a button answer still resumes from the durable table
 * while a typed message becomes a fresh turn.
 */
export const PENDING_QUESTION_KEY_PREFIX = 'assistant:ask';

/**
 * Builds the dedupe key for a vendor + dedupe id pair.
 */
export const dedupeKey = (vendor: string, dedupeId: string): string =>
  `${DEDUPE_KEY_PREFIX}:${vendor}:${dedupeId}`;

/**
 * Builds the link-nonce key for a nonce string.
 */
export const linkNonceKey = (nonce: string): string =>
  `${LINK_NONCE_KEY_PREFIX}:${nonce}`;

/**
 * Builds the pending-question hot-pointer key for a Cue user id. Used by the
 * inbound router's free-text fast-path (`EXISTS`) and set (value = the
 * `pending_question` row id) when an `ask_user` turn suspends (Story 5).
 */
export const pendingQuestionKey = (userId: string): string =>
  `${PENDING_QUESTION_KEY_PREFIX}:${userId}`;

/**
 * Prefix for the live-status handle (`StatusSession`, Story 10 / ADR 0012),
 * keyed per chat + turn. It holds the JSON `{ draftId | messageId, chatType,
 * locale, phase }` for the in-flight turn's animated status surface so creating
 * it is IDEMPOTENT — a second create for the same turn re-reads the existing
 * handle instead of orphaning a second draft/message. Short-lived (TTL
 * `ASSISTANT_STATUS_SESSION_TTL_SECONDS`); cleared when the turn finalizes. The
 * surface Stories 12/13 animate; this story builds only the store + lifecycle.
 */
export const STATUS_SESSION_KEY_PREFIX = 'assistant:status';

/**
 * Builds the live-status handle key for a chat + turn pair. Keyed per turn (not
 * just per chat) so concurrent turns in the same chat never share one status
 * surface, while a re-entrant create within ONE turn is idempotent.
 */
export const statusSessionKey = (
  vendorChatId: string,
  turnId: string,
): string => `${STATUS_SESSION_KEY_PREFIX}:${vendorChatId}:${turnId}`;

/**
 * Prefix for the per-user serialization lock (Story 11 / ADR 0039), keyed by the
 * Cue user id. The value is a unique fencing token (`randomUUID`) written with
 * `SET key token NX PX <ttlMs>`: NX makes acquisition mutually exclusive, PX
 * auto-expires it so a crashed holder never deadlocks. Release is token-checked
 * (Lua compare-and-del) so only the holder can unlock; a watchdog renews the TTL
 * (also token-checked) while work is in progress. Disjoint keyspace from
 * {@link PENDING_QUESTION_KEY_PREFIX} / {@link STATUS_SESSION_KEY_PREFIX} so the
 * mutex never collides with suspend or status state. Consumed by Story 14
 * (queue-after) and the ADR-0010 `ask_user`
 * resume double-resume race — see `docs/adr/0039-assistant-per-user-serialization-lock.md`.
 */
export const USER_LOCK_KEY_PREFIX = 'assistant:lock';

/**
 * Builds the per-user serialization-lock key for a Cue user id. One key per user
 * serializes that user's turns; different users never contend.
 */
export const userLockKey = (userId: string): string =>
  `${USER_LOCK_KEY_PREFIX}:${userId}`;

/**
 * Prefix for the per-user debounce buffer (Story 14a / ADR 0042), keyed by the
 * Cue user id. A Redis LIST of JSON-serialized inbound entries in ARRIVAL ORDER
 * (RPUSH appends): every accepted simple-message inbound (text or already-
 * transcribed voice) is buffered here while its ~2 s window is open. When the
 * delayed drain job fires it atomically reads + clears this list (LRANGE+DEL Lua)
 * and runs ONE combined turn. The buffer — never the BullMQ job — is the source
 * of truth for the window's messages, so re-arming (replacing the delayed job)
 * can never drop a buffered message. Disjoint keyspace from the lock / status /
 * ask keys so the debounce buffer never collides with any other assistant state.
 */
export const DEBOUNCE_BUFFER_KEY_PREFIX = 'assistant:debounce:buf';

/**
 * Builds the per-user debounce-buffer LIST key for a Cue user id. One list per
 * user accumulates that user's in-window messages in arrival order.
 */
export const debounceBufferKey = (userId: string): string =>
  `${DEBOUNCE_BUFFER_KEY_PREFIX}:${userId}`;

/**
 * Builds the STABLE per-user BullMQ jobId for the debounce-drain job (Story 14a /
 * ADR 0042). Because the jobId is keyed only by user, re-arming a window targets
 * the SAME job: the coordinator removes the still-delayed job and re-adds it with
 * a fresh delay, sliding the window to the latest inbound. One in-flight drain
 * job per user at a time; different users never share a drain job.
 *
 * NOTE: BullMQ forbids `:` in a custom job id (it reserves the colon for its own
 * internal key composition and throws `Custom Id cannot contain :`), so the
 * separator here is a hyphen — NOT the colon used by the Redis key builders above.
 */
export const debounceJobId = (userId: string): string => `debounce-${userId}`;

/**
 * Builds a UNIQUE per-arm BullMQ jobId for a queue-after re-poll (Story 14a / ADR
 * 0042). Unlike {@link debounceJobId} (the stable window job re-armed by the
 * inbound path), the queue-after re-arm fires from INSIDE the still-active drain
 * job — and under real BullMQ `remove()` on an active job is a no-op and `add()`
 * with an existing jobId is IGNORED, so re-using the stable id would silently fail
 * to schedule the re-poll and stall the queued-after batch until another inbound.
 * A fresh unique id (with the per-arm `nonce`) is one BullMQ WILL create, so the
 * re-poll always actually runs after the in-flight turn frees the lock — with no
 * extra inbound. Hyphen-separated for the same reason as {@link debounceJobId}
 * (BullMQ forbids `:` in a custom job id).
 */
export const debounceAfterJobId = (userId: string, nonce: string): string =>
  `debounce-after-${userId}-${nonce}`;

/**
 * Prefix for the active reply-keyboard surface flag (Story 16 / ADR 0045), keyed
 * by the Cue user id. Its VALUE is the id of the keyboard currently docked for the
 * user (`main` or `settings`); its mere presence is the active-surface gate the
 * inbound router consults to decide whether a plain-text message that equals a
 * known button label is a KEYBOARD ACTION versus ordinary conversation. Gating on
 * this flag is the disambiguation that prevents hijacking a user who literally
 * TYPES "Settings": a label is routed as a keyboard tap ONLY when the reply
 * keyboard is the active surface AND the docked keyboard actually owns that label.
 * Set whenever a keyboard is docked, deleted when the keyboard is removed
 * (Disconnect). Disjoint keyspace from the lock / status / ask / debounce / stop
 * keys so the active-surface flag never collides with any other assistant state.
 */
export const ACTIVE_KEYBOARD_KEY_PREFIX = 'assistant:keyboard';

/**
 * Builds the active reply-keyboard surface key for a Cue user id. One key per user
 * records which keyboard (if any) is currently docked for that user's chat.
 */
export const activeKeyboardKey = (userId: string): string =>
  `${ACTIVE_KEYBOARD_KEY_PREFIX}:${userId}`;

/**
 * Prefix for the latest reply-keyboard button result (Story 16 / ADR 0045), keyed
 * by the Cue user id. Its VALUE is a short human-readable line describing the most
 * recent deterministic button outcome (e.g. "Showed this week's schedule"), which
 * the context builder injects into the NEXT turn's VOLATILE TAIL only — never the
 * cached prefix (ADR 0004 cache stability). Overwritten on each button tap and
 * read-then-cleared on the next model turn so it is a one-shot nudge, with a short
 * TTL as a self-cleaning backstop. Disjoint keyspace from every other assistant
 * key so the last-button context never collides with the lock / status / ask /
 * debounce / stop / active-keyboard state.
 */
export const LAST_BUTTON_KEY_PREFIX = 'assistant:lastButton';

/**
 * Builds the latest-button-result key for a Cue user id. One key per user holds
 * the most recent button outcome line awaiting injection into the next turn.
 */
export const lastButtonKey = (userId: string): string =>
  `${LAST_BUTTON_KEY_PREFIX}:${userId}`;
