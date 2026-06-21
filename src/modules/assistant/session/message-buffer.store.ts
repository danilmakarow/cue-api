import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

import { debounceBufferKey } from '../../redis/redis.constants';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { AssistantConfig } from '../assistant.config';
import {
  ChatType,
  InboundKind,
} from '@/modules/external-vendor/external-vendor.types';

/**
 * One buffered simple-message inbound (Story 14a / ADR 0042) awaiting its
 * debounce window to close. Carries everything {@link TurnRunnerService.runFromMessage}
 * needs so the drained, combined turn can run with no extra lookup. The text is
 * already normalized (a voice note's transcript, a text note's body); `kind`
 * tags how it is persisted. The FIRST entry of a drained window supplies the
 * shared chat/correlation/locale fields for the combined turn.
 */
export interface BufferedMessage {
  text: string;
  kind: InboundKind;
  vendorChatId: string;
  correlationId: string;
  chatType?: ChatType;
  languageCode?: string;
  /**
   * STT-reported spoken language for a voice note (v2 Task 4 / ADR 0051) — the
   * highest-priority signal for the post-STT loading-word locale. Undefined for a
   * typed message or when the STT model does not report a language. The FIRST
   * buffered entry's value seeds the combined turn (like the other shared fields).
   */
  sttLanguage?: string;
}

/**
 * Lua: atomically read the whole list in order and delete it, returning the
 * read elements. A plain `LRANGE` then `DEL` would race a concurrent RPUSH
 * (a message arriving between the read and the delete would be silently dropped);
 * doing both in one server-side script makes the drain atomic, so every buffered
 * message is either fully drained by this call or still present for the next one
 * — never lost in the gap. Returns the list elements (possibly empty).
 */
const DRAIN_BUFFER = `
local items = redis.call('lrange', KEYS[1], 0, -1)
redis.call('del', KEYS[1])
return items`;

/**
 * L3 per-user message buffer (Story 14a / ADR 0042) — a Redis LIST that holds a
 * user's in-window simple messages in ARRIVAL ORDER while their ~2 s debounce
 * window is open. {@link append} RPUSHes one normalized entry (preserving order)
 * and refreshes the buffer TTL; {@link drain} atomically reads + clears the list
 * (LRANGE+DEL Lua) so the delayed drain job runs ONE combined turn over the
 * window. The buffer — never the BullMQ job — is the source of truth for the
 * window's messages, so re-arming (replacing the delayed job) can never drop one.
 *
 * Redis-only (no DB entity), matching the held-conflict / status-session /
 * user-lock precedent. See `docs/adr/0042-assistant-inbound-debounce-and-queue-after.md`.
 */
@Injectable()
export class MessageBufferStore {
  private readonly logger = new Logger(MessageBufferStore.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: AssistantConfig,
  ) {}

  /**
   * Appends one normalized message to the user's debounce buffer in arrival
   * order (RPUSH) and refreshes the buffer TTL so an abandoned window self-cleans.
   * The TTL is generous (the window plus a queue-after margin) so a queued-after
   * batch that re-buffers is never reaped before it re-runs. Returns the buffer's
   * post-append length: a return of 1 means THIS entry is the window's FIRST (it
   * will seed the combined turn — and, for a voice note, the turn finalizes its
   * status surface), so the caller can finalize a non-first voice surface itself
   * (FIX 3 — every opened voice surface is finalized, never orphaned to TTL).
   */
  async append(userId: string, message: BufferedMessage): Promise<number> {
    const key = debounceBufferKey(userId);

    const length = await this.redis.rpush(key, JSON.stringify(message));

    await this.redis.pexpire(key, this.bufferTtlMs());

    return length;
  }

  /**
   * Atomically drains the user's buffer: reads every entry in arrival order and
   * clears the list in one Lua script (so a concurrent {@link append} cannot be
   * lost in a read→delete gap). Returns the parsed entries in arrival order; a
   * malformed entry is skipped (never crashes the drain — the queue is
   * `attempts:1`). An empty buffer returns an empty array.
   */
  async drain(userId: string): Promise<BufferedMessage[]> {
    const raw = (await this.redis.eval(
      DRAIN_BUFFER,
      1,
      debounceBufferKey(userId),
    )) as string[];

    const messages: BufferedMessage[] = [];

    for (const item of raw) {
      const parsed = this.parse(item);

      if (parsed) {
        messages.push(parsed);
      }
    }

    return messages;
  }

  /**
   * Re-buffers an already-drained batch at the FRONT of the user's buffer (LPUSH
   * in reverse so arrival order is preserved), used by the queue-after path when
   * the per-user lock is held. Any messages that arrived since the drain are
   * appended after these by their own {@link append}, so global arrival order is
   * kept and nothing is dropped. Refreshes the TTL.
   */
  async requeueFront(
    userId: string,
    messages: BufferedMessage[],
  ): Promise<void> {
    if (messages.length === 0) {
      return;
    }

    const key = debounceBufferKey(userId);
    // LPUSH prepends; pushing in reverse leaves the batch in original order at the
    // head, ahead of anything that arrived during the in-flight turn.
    const serialized = messages.map((message) => JSON.stringify(message));

    await this.redis.lpush(key, ...serialized.reverse());
    await this.redis.pexpire(key, this.bufferTtlMs());
  }

  /**
   * Parses one buffered entry, returning null (and logging) on malformed JSON so
   * a single bad entry can never crash a drain.
   */
  private parse(item: string): BufferedMessage | null {
    try {
      return JSON.parse(item) as BufferedMessage;
    } catch (error) {
      this.logger.warn(
        `Dropping malformed debounce buffer entry: ${String(error)}`,
      );

      return null;
    }
  }

  /**
   * Buffer key TTL (ms): the debounce window plus a queue-after margin, with a
   * small floor, so an abandoned window self-cleans yet a queued-after re-buffer
   * is never reaped before it re-runs.
   */
  private bufferTtlMs(): number {
    return Math.max(
      this.config.debounceWindowMs + this.config.debounceQueueAfterMs,
      this.config.debounceWindowMs * 5,
    );
  }
}
