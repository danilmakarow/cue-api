import { randomUUID } from 'node:crypto';

import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';

import { BufferedMessage, MessageBufferStore } from './message-buffer.store';
import { TurnRunnerService } from './turn-runner.service';
import { UserLockStore } from './user-lock.store';
import {
  debounceAfterJobId,
  debounceJobId,
  DEBOUNCE_QUEUE_NAME,
} from '../../redis/redis.constants';
import { AssistantConfig } from '../assistant.config';
import { DebounceAnswerPayload, DebounceQueueJob } from '../assistant.types';
import { User } from '@/modules/database/entities';
import { InboundKind } from '@/modules/external-vendor/external-vendor.types';

/**
 * Sentinel returned by {@link DebounceCoordinatorService.runDrainedTurn}'s
 * `runExclusive` call when the per-user lock is already held (a turn is in
 * flight). It tells the drain to QUEUE-AFTER — re-buffer the drained batch and
 * re-arm the delayed job — rather than run concurrently.
 */
const LOCK_BUSY = Symbol('debounce-lock-busy');

/**
 * L1/L3 debounce coordinator (Story 14a / ADR 0042) — the inbound flow-control
 * seam. It collapses a user's rapid-fire simple messages into ONE turn and
 * serializes that turn behind the Story 11 per-user lock so a mid-turn message
 * runs AFTER the in-flight turn, never concurrently and never dropped.
 *
 * Two halves:
 * - {@link buffer} (called from the consumer on an accepted simple message):
 *   appends the normalized message to the user's Redis buffer in arrival order
 *   and (re-)schedules a single delayed drain job at now + the debounce window.
 *   Each new inbound RE-ARMS the window (the job is removed + re-added later), so
 *   the timer always slides to the LAST message; the buffer holds every message.
 * - {@link drainAndRun} (called from the {@link DebounceConsumer} when the delayed
 *   job fires): atomically drains the buffer, COMBINES the messages by
 *   concatenation in arrival order into one turn, and runs it under the per-user
 *   lock. If the lock is held, it re-buffers the batch and re-arms the job (queue
 *   -after) instead of running — the in-flight turn finishes first.
 *
 * `ask_user` answers ARE serialized too (ADR 0042 / Story 11). An answer is never
 * COMBINED (it acknowledges a specific callback and must not coalesce), so it does
 * NOT go through the Redis buffer — instead {@link runAnswerExclusive} runs it
 * directly under the same per-user lock, and if the lock is held it queues-after
 * by re-carrying the answer payload on a fresh delayed job. This keeps a
 * simple-message turn and an answer turn from ever running concurrently for one
 * user, while preserving the atomic `claimPending` double-resume guard.
 *
 * Queue-after under real BullMQ: a re-poll armed from INSIDE the still-active
 * drain/answer job CANNOT reuse the stable window jobId (BullMQ ignores `add()`
 * for an existing id and `remove()` on an active job is a no-op), so it would
 * never schedule and the batch would stall until another inbound. {@link armAfter}
 * therefore arms a UNIQUE jobId BullMQ actually creates, so the re-poll always
 * runs once the in-flight turn frees the lock — with no extra inbound.
 *
 * Degrade-never-throw: the buffer/queue calls swallow their own faults so the
 * `attempts:1` consumer path is never broken; a fault still leaves the message
 * buffered so the next drain (or a follow-up inbound's re-arm) picks it up.
 */
@Injectable()
export class DebounceCoordinatorService {
  private readonly logger = new Logger(DebounceCoordinatorService.name);

  constructor(
    @InjectQueue(DEBOUNCE_QUEUE_NAME)
    private readonly debounceQueue: Queue<DebounceQueueJob>,
    private readonly bufferStore: MessageBufferStore,
    private readonly userLock: UserLockStore,
    private readonly turnRunner: TurnRunnerService,
    private readonly config: AssistantConfig,
  ) {}

  /**
   * Accepts one normalized simple message into the user's debounce window:
   * appends it to the Redis buffer (arrival order) and (re-)arms the single
   * delayed drain job at now + the debounce window. The append happens FIRST so
   * even if the re-arm faults the message is still buffered and a later inbound's
   * re-arm (or a previously-armed job) will drain it — nothing is dropped. The
   * `userId` is the drain target; the `vendorChatId`/`correlationId`/locale on the
   * FIRST buffered entry seed the combined turn.
   *
   * Returns true when this entry became the window's FIRST (it will seed the
   * combined turn, and a voice seed's status surface is finalized by the turn), so
   * the caller can finalize a NON-seed voice surface itself (FIX 3 — every opened
   * voice surface is finalized, never left orphaned until its TTL).
   */
  async buffer(userId: string, message: BufferedMessage): Promise<boolean> {
    const length = await this.bufferStore.append(userId, message);

    await this.armWindow(userId, this.config.debounceWindowMs);

    return length === 1;
  }

  /**
   * Runs an `ask_user` answer/resume turn under the per-user lock so it serializes
   * with a user's simple-message turns instead of running concurrently (ADR 0042 /
   * Story 11). Called directly by the consumer on an accepted answer flow (NOT
   * buffered — an answer is never combined). If the lock is held by an in-flight
   * turn the answer queues-after: a fresh UNIQUE delayed job re-carries the answer
   * payload, so it re-attempts shortly AFTER the in-flight turn frees the lock
   * (never concurrently, never dropped). The atomic `claimPending` guard inside the
   * resume still defends against a double-resume. Never throws (the inbound path is
   * `attempts:1`): a fault re-queues the answer rather than dropping it.
   */
  async runAnswerExclusive(
    user: User,
    answer: DebounceAnswerPayload,
  ): Promise<void> {
    try {
      const ran = await this.runAnswerTurn(user, answer);

      if (!ran) {
        await this.armAfter(user.id, answer);
      }
    } catch (error) {
      this.logger.error(
        `Debounce answer turn failed for user ${user.id}; re-queueing: ${String(error)}`,
      );

      await this.armAfter(user.id, answer);
    }
  }

  /**
   * Processes one fired debounce job (called by the {@link DebounceConsumer} after
   * it resolves the {@link User}). An `answer`-carrying job re-attempts that queued
   * -after `ask_user` answer under the lock; otherwise it drains the user's
   * simple-message buffer and runs ONE combined turn. Empty-buffer drains are a
   * no-op (a prior queue-after already ran the batch, or it was drained by a
   * re-armed job). On a held lock the batch is re-buffered + a fresh job armed
   * (queue-after). Never throws — the debounce queue is `attempts:1`, so a thrown
   * drain would lose the batch; faults are caught and the batch is left buffered
   * for retry.
   */
  async drainAndRun(user: User, job?: DebounceQueueJob): Promise<void> {
    if (job?.answer) {
      await this.runAnswerExclusive(user, job.answer);

      return;
    }

    const messages = await this.bufferStore.drain(user.id);

    if (messages.length === 0) {
      return;
    }

    try {
      const ranImmediately = await this.runDrainedTurn(user, messages);

      if (!ranImmediately) {
        // The per-user lock was held (a turn is in flight). Re-buffer the batch at
        // the front (arrival order preserved) and arm a FRESH delayed job so it
        // runs AFTER the in-flight turn — never concurrently, never dropped.
        await this.queueAfter(user.id, messages);
      }
    } catch (error) {
      // A turn fault must not lose the drained batch (attempts:1). Re-buffer +
      // re-arm so the next window picks it up; a status/reply fault inside the
      // turn already degraded never-throw, so reaching here is a true infra fault.
      this.logger.error(
        `Debounce drain failed for user ${user.id}; re-buffering the batch: ${String(error)}`,
      );

      await this.queueAfter(user.id, messages);
    }
  }

  /**
   * Runs the combined turn under the per-user lock (Story 11). Returns true when
   * the turn actually ran (lock acquired), false when the lock was held (the
   * `onBusy` sentinel), signalling the caller to queue-after. The combined turn
   * is seeded from the FIRST entry (chat/correlation/locale) with the texts joined
   * in arrival order; voice transcripts are already plain text here, so a mixed
   * voice/text window combines transparently. The turn is ALWAYS a fresh
   * `simple_message` — a pending-question answer is never debounced (the consumer
   * routes it directly), so combining can never corrupt an `ask_user` resume.
   */
  private async runDrainedTurn(
    user: User,
    messages: BufferedMessage[],
  ): Promise<boolean> {
    const first = messages[0];
    const combinedText = messages
      .map((message) => message.text)
      .filter((text) => text.length > 0)
      .join('\n');

    if (combinedText.length === 0) {
      // Nothing substantive to run (all entries were empty); treat as ran.
      return true;
    }

    // A window that mixed in any voice transcript is persisted as a voice
    // transcript; an all-text window as text.
    const kind = messages.some((message) => message.kind === InboundKind.Voice)
      ? InboundKind.Voice
      : InboundKind.Text;

    const result = await this.userLock.runExclusive<true | typeof LOCK_BUSY>(
      user.id,
      async () => {
        await this.turnRunner.runFromMessage({
          user,
          text: combinedText,
          kind,
          vendorChatId: first.vendorChatId,
          correlationId: first.correlationId,
          origin: 'simple_message',
          callbackId: null,
          chatType: first.chatType,
          languageCode: first.languageCode,
          // The seed entry's STT language drives the post-STT loading-word locale
          // when the window opened on a voice note (v2 Task 4 / ADR 0051).
          sttLanguage: first.sttLanguage,
        });

        return true;
      },
      () => LOCK_BUSY,
    );

    return result !== LOCK_BUSY;
  }

  /**
   * Runs ONE `ask_user` answer/resume turn under the per-user lock. Returns true
   * when it actually ran (lock acquired), false when the lock was held (the
   * `onBusy` sentinel → the caller queues-after). The answer rides verbatim from
   * the job payload — it is never combined — so the resume's atomic `claimPending`
   * guard is the only double-resume defence (unchanged). The lock makes a
   * simple-message turn and this answer turn mutually exclusive for the user.
   */
  private async runAnswerTurn(
    user: User,
    answer: DebounceAnswerPayload,
  ): Promise<boolean> {
    const result = await this.userLock.runExclusive<true | typeof LOCK_BUSY>(
      user.id,
      async () => {
        await this.turnRunner.runFromMessage({
          user,
          text: answer.text,
          kind: answer.kind,
          vendorChatId: answer.vendorChatId,
          correlationId: answer.correlationId,
          origin: answer.origin,
          callbackId: answer.callbackId,
          chatType: answer.chatType,
          languageCode: answer.languageCode,
          // A voice answer's STT language drives its post-STT loading-word locale
          // (v2 Task 4 / ADR 0051); undefined for a typed answer.
          sttLanguage: answer.sttLanguage,
        });

        return true;
      },
      () => LOCK_BUSY,
    );

    return result !== LOCK_BUSY;
  }

  /**
   * Queue-after for a simple-message batch: re-buffers the drained batch at the
   * front of the buffer (arrival order kept) and arms a FRESH delayed job a short
   * delay out, so the batch re-polls the lock shortly AFTER the in-flight turn
   * completes. The lock auto-expires regardless, so this can never deadlock; the
   * batch lives in the buffer the whole time, so it can never be dropped.
   */
  private async queueAfter(
    userId: string,
    messages: BufferedMessage[],
  ): Promise<void> {
    await this.bufferStore.requeueFront(userId, messages);
    await this.armAfter(userId);
  }

  /**
   * (Re-)arms the single per-user delayed WINDOW job at now + the debounce window.
   * Removing the still-delayed job before re-adding it is what slides the window to
   * the latest message: a plain re-add with the same stable jobId would be IGNORED
   * by BullMQ's jobId dedup (the original delay would stand), so we remove-then-add.
   * Used ONLY from the inbound {@link buffer} path, where the window job is still
   * DELAYED (never active), so the remove genuinely takes effect. The remove is
   * best-effort (a job that already fired is gone); the add carries `attempts:1` so
   * a drain never replays a committed turn. The message stays buffered no matter
   * what, so an arm fault never drops it.
   */
  private async armWindow(userId: string, delayMs: number): Promise<void> {
    const jobId = debounceJobId(userId);

    try {
      // Remove the pending (still-delayed) job so the re-add takes effect; if the
      // job has already moved out of the delayed set this is a harmless no-op.
      await this.debounceQueue.remove(jobId);
    } catch (error) {
      this.logger.debug(
        `Debounce re-arm remove no-op for user ${userId}: ${String(error)}`,
      );
    }

    await this.debounceQueue.add(
      'drain',
      { userId },
      { jobId, delay: delayMs, attempts: 1 },
    );
  }

  /**
   * Arms a queue-after re-poll with a UNIQUE per-arm jobId at now +
   * `debounceQueueAfterMs`. This is the FIX for queue-after under real BullMQ: the
   * re-poll is armed from INSIDE the still-active drain/answer job, where the
   * stable window jobId is the ACTIVE job — `remove()` on it is a no-op and `add()`
   * with that id is IGNORED, so re-using it would never schedule and the batch
   * would stall until another inbound. A fresh unique id (via {@link
   * debounceAfterJobId}) is one BullMQ WILL create, so the re-poll always fires
   * once the in-flight turn frees the lock — with NO extra inbound. An optional
   * `answer` rides the job for a queued-after `ask_user` answer (re-attempted
   * verbatim); omit it for a simple-message batch (whose messages live in the
   * buffer). Best-effort `add` — degrade-never-throw on `attempts:1`.
   */
  private async armAfter(
    userId: string,
    answer?: DebounceAnswerPayload,
  ): Promise<void> {
    const jobId = debounceAfterJobId(userId, randomUUID());

    try {
      await this.debounceQueue.add(
        'drain-after',
        { userId, answer },
        { jobId, delay: this.config.debounceQueueAfterMs, attempts: 1 },
      );
    } catch (error) {
      this.logger.error(
        `Debounce queue-after arm failed for user ${userId}: ${String(error)}`,
      );
    }
  }
}
