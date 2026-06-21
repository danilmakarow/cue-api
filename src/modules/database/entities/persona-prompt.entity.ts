import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseEntity } from './base.entity';
import { User } from './user.entity';

/**
 * Provenance of a persona prompt (Story 18 / ADR 0014). A `PRESET` row is a
 * curated, user-agnostic persona seeded into the DB (e.g. the out-of-box
 * "Jarvis") with `userId = null`, browsable/pickable later; a `CUSTOM` row is a
 * single user's own active persona (their `userId` set). The seeded preset is
 * also the fallback the GET endpoint returns when a user has set nothing.
 */
export enum PersonaPromptSource {
  PRESET = 'preset',
  CUSTOM = 'custom',
}

/**
 * PersonaPrompt entity (Story 18 / ADR 0014) — the per-user AI personality the
 * assistant adopts. Two row shapes share the table:
 *
 * - a `PRESET` row (`userId = null`, `presetName` set) is a curated persona
 *   seeded once (the out-of-box "Jarvis"); one seeded row is enough for now (no
 *   preset-management UI yet);
 * - a `CUSTOM` row (`userId` set, unique → one per user) is a user's own active
 *   persona, written through `GET`/`PATCH /users/me/persona-settings`.
 *
 * The active persona text is injected as a prompt block in the PER-USER stable
 * region — between the profile/groups blocks and the rolling summary, with NO
 * `cacheBoundary` of its own (the region is closed by breakpoint #2). It MUST
 * never join system block 1, whose shared cross-user cached prefix (system
 * prompt + tool defs) stays byte-stable for every user (ADR 0004 / ADR 0014).
 * When a user has no `CUSTOM` row, the seeded "Jarvis" preset is the fallback.
 */
@Entity()
@Index(['userId'], { unique: true, where: '"userId" IS NOT NULL' })
export class PersonaPrompt extends BaseEntity {
  /**
   * The owning user for a `CUSTOM` persona, or null for a curated `PRESET` row.
   * A partial unique index (above) enforces at-most-one `CUSTOM` row per user
   * while leaving preset rows (all `null`) unconstrained.
   */
  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'userId' })
  user: User | null;

  /**
   * Human-facing name for a curated `PRESET` row (e.g. "Jarvis"), null for a
   * user's `CUSTOM` persona. Lets a future presets screen list pickable personas.
   */
  @Column({ type: String, nullable: true })
  presetName: string | null;

  /**
   * The persona instruction text injected into the prompt's per-user region. For
   * the seeded preset this is the dry, formal English-butler "Jarvis" copy; for a
   * `CUSTOM` row it is whatever the user wrote. Non-empty and length-bounded by
   * the PATCH DTO before it ever lands here.
   */
  @Column({ type: 'text' })
  promptText: string;

  @Column({
    type: 'enum',
    enum: PersonaPromptSource,
    default: PersonaPromptSource.CUSTOM,
  })
  source: PersonaPromptSource;
}
