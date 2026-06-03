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
