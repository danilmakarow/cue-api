import { Injectable } from '@nestjs/common';
import { LessThanOrEqual } from 'typeorm';

import {
  PendingQuestion,
  PendingQuestionStatus,
} from '@/modules/database/entities';
import { PendingQuestionRepository } from '@/modules/database/repositories';
import { BaseDatabaseService } from '@/modules/database/services/base-database.service';

/**
 * Database service for the PendingQuestion entity (ADR 0010 — the durable store
 * for a suspended `ask_user` turn). Exposes the finders and the atomic
 * compare-and-set claim the later suspend/resume wave will drive; all writes go
 * through `.save()` / the query builder, never a feature-service bypass.
 */
@Injectable()
export class PendingQuestionDatabaseService extends BaseDatabaseService<PendingQuestion> {
  private pendingQuestionRepository: PendingQuestionRepository;

  constructor(pendingQuestionRepository: PendingQuestionRepository) {
    super(pendingQuestionRepository);
    this.pendingQuestionRepository = pendingQuestionRepository;
  }

  /**
   * Returns the single open (`AWAITING`) question for a conversation, or null if
   * none is pending. The partial unique index guarantees at most one such row, so
   * the durable-path resolver can treat this as the question to answer.
   */
  findAwaitingByConversation(
    conversationId: string,
  ): Promise<PendingQuestion | null> {
    return this.findOneBy({
      conversationId,
      status: PendingQuestionStatus.AWAITING,
    });
  }

  /**
   * Atomically claims a pending question for resume: flips `AWAITING → ANSWERED`
   * for exactly this row and returns the row as it was before the flip. This is
   * the durable half of the ADR 0010 idempotent claim — `UPDATE ... WHERE
   * status = 'AWAITING' RETURNING *`. A null return means the row was already
   * claimed (Redis `GETDEL` won the race, or a concurrent inbound update beat us)
   * and the caller MUST ignore it rather than double-resume.
   */
  async claimAwaiting(id: string): Promise<PendingQuestion | null> {
    const result = await this.pendingQuestionRepository
      .createQueryBuilder()
      .update(PendingQuestion)
      .set({ status: PendingQuestionStatus.ANSWERED })
      .where('id = :id', { id })
      .andWhere('status = :awaiting', {
        awaiting: PendingQuestionStatus.AWAITING,
      })
      .returning('*')
      .execute();

    const [claimed] = result.raw as PendingQuestion[];

    if (!claimed) {
      return null;
    }

    return claimed;
  }

  /**
   * Returns still-`AWAITING` rows whose `expiresAt` is on or before the given
   * timestamp — the candidate set for the `@nestjs/schedule` cleanup sweep that
   * marks them `EXPIRED`. Served by the `(status, expiresAt)` index.
   */
  findExpiredAwaiting(now: Date, limit: number): Promise<PendingQuestion[]> {
    return this.findAll({
      where: {
        status: PendingQuestionStatus.AWAITING,
        expiresAt: LessThanOrEqual(now),
      },
      order: { expiresAt: 'ASC' },
      take: limit,
    });
  }
}
