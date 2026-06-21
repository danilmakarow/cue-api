/**
 * Redis key prefixes and the BullMQ queue name used by the assistant. Kept in
 * one place so the controller, consumer, and orchestrator agree on key shapes.
 */

/** BullMQ queue name for accepted inbound webhook jobs. */
export const WEBHOOK_QUEUE_NAME = 'assistant-webhook';

/** Background queue name for post-turn summary + memory-extraction jobs. */
export const BACKGROUND_QUEUE_NAME = 'assistant-background';

/** Prefix for the at-least-once dedupe guard, keyed by `${vendor}:${dedupeId}`. */
export const DEDUPE_KEY_PREFIX = 'assistant:dedupe';

/** Prefix for single-use link nonces, keyed by the nonce string. */
export const LINK_NONCE_KEY_PREFIX = 'assistant:link';

/** Prefix for held conflicting writes, keyed by the inline-keyboard callback id. */
export const HELD_CONFLICT_KEY_PREFIX = 'assistant:held';

/**
 * Prefix for the hot pointer to a suspended `ask_user` question, keyed by the
 * Cue user id. Its mere presence is the cheap `EXISTS` signal the inbound router
 * uses to send a free-text reply into the answer flow while a question is open;
 * its VALUE is the durable `pending_question` row id, so the free-text resolve
 * `GETDEL`s the key (atomic claim of the hot window) and then claims that exact
 * row in Postgres. Deliberately disjoint from {@link HELD_CONFLICT_KEY_PREFIX}
 * (`assistant:ask` vs `assistant:held`) so the two suspend/resume paths never
 * collide — see `docs/specs/assistant-layered-architecture.md`. Set by Story 5
 * when an `ask_user` turn suspends (TTL `ASSISTANT_ASK_USER_TTL_SECONDS`) and
 * cleared on claim; after it lapses a button answer still resumes from the
 * durable table while a typed message becomes a fresh turn.
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
 * Builds the held-conflict key for a callback id.
 */
export const heldConflictKey = (callbackId: string): string =>
  `${HELD_CONFLICT_KEY_PREFIX}:${callbackId}`;

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
 * {@link HELD_CONFLICT_KEY_PREFIX} / {@link PENDING_QUESTION_KEY_PREFIX} /
 * {@link STATUS_SESSION_KEY_PREFIX} so the mutex never collides with suspend or
 * status state. Consumed by Story 14 (queue-after) and the ADR-0010 `ask_user`
 * resume double-resume race — see `docs/adr/0039-assistant-per-user-serialization-lock.md`.
 */
export const USER_LOCK_KEY_PREFIX = 'assistant:lock';

/**
 * Builds the per-user serialization-lock key for a Cue user id. One key per user
 * serializes that user's turns; different users never contend.
 */
export const userLockKey = (userId: string): string =>
  `${USER_LOCK_KEY_PREFIX}:${userId}`;
