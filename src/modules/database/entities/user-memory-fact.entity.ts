import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseEntity } from './base.entity';
import { User } from './user.entity';

/**
 * Category of a durable user fact (ADR 0005 tier 3 — the structured profile).
 * Drives which subset is injected as prompt block 3 and how the iOS settings
 * screen groups facts for review/editing.
 */
export enum UserMemoryFactType {
  WORKING_HOURS = 'working_hours',
  NO_GO_WINDOW = 'no_go_window',
  RECURRING_COMMITMENT = 'recurring_commitment',
  PREFERENCE = 'preference',
  PERSON = 'person',
  PLACE = 'place',
  OTHER = 'other',
  /**
   * Standing double-booking policy (Story 15 / ADR 0011 + 0044) — the durable,
   * EXPLICIT-only authorization that lets the assistant book over (or refuse) an
   * overlap WITHOUT asking each time. Its `value` is `{ policy: ConflictPolicy }`.
   * NEVER inferred: only a fact the user explicitly set counts as standing
   * authorization, so the background extractor must never emit this type. A single
   * in-message "yes, double-book it" is in-message authorization (confirmOverlap),
   * not a standing policy.
   */
  CONFLICT_POLICY = 'conflict_policy',
}

/**
 * The three standing double-booking dispositions a `CONFLICT_POLICY` fact may
 * carry (Story 15 / ADR 0011 + 0044). `ALLOW` lets the assistant book over an
 * overlap without asking; `DENY` refuses every overlap outright (even an
 * in-message `confirmOverlap`); `ASK` is the explicit form of the default — always
 * ask. Absent any fact, the system defaults to ASK (default-deny).
 */
export enum ConflictPolicy {
  ALLOW = 'allow',
  ASK = 'ask',
  DENY = 'deny',
}

/**
 * Provenance of a fact: `inferred` by the background extractor vs `explicit`
 * (the user stated it or edited it in settings). Explicit facts are trusted
 * over inferred ones when both touch the same key.
 */
export enum UserMemoryFactSource {
  INFERRED = 'inferred',
  EXPLICIT = 'explicit',
}

/**
 * UserMemoryFact entity — a single durable, typed fact about a user (ADR 0005
 * tier 3). Many per User; only the relevant subset is injected per turn. The
 * (userId, type) index serves the per-turn relevant-subset query. Editable from
 * the iOS settings screen so users can see/correct what the assistant believes.
 */
@Entity()
@Index(['userId', 'type'])
export class UserMemoryFact extends BaseEntity {
  @Column()
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'enum', enum: UserMemoryFactType })
  type: UserMemoryFactType;

  /**
   * Stable identifier for the fact within its type (e.g. `gym`, `lunch`), so a
   * later extraction can update the same fact instead of duplicating it.
   */
  @Column()
  key: string;

  /**
   * The fact's structured value (jsonb), shape depending on `type` — e.g.
   * `{ days: ['MO','WE','FR'], time: '07:00' }` for a recurring commitment.
   */
  @Column({ type: 'jsonb' })
  value: Record<string, unknown>;

  /**
   * Extractor confidence in [0, 1]. Numeric so low-confidence inferred facts can
   * be filtered out of the prompt or surfaced for user confirmation.
   */
  @Column({ type: 'numeric', precision: 4, scale: 3, default: 1 })
  confidence: number;

  @Column({
    type: 'enum',
    enum: UserMemoryFactSource,
    default: UserMemoryFactSource.INFERRED,
  })
  source: UserMemoryFactSource;
}
