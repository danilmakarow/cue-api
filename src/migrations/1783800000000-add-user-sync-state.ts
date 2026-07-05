import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `user_sync_state` table — one row per user holding a monotonic
 * `revision` counter that backs the cheap `GET /sync/state` check. Every task /
 * group / calendar mutation bumps the revision atomically (inside the same
 * transaction); the iOS client compares it for equality to decide whether to
 * pull the delta.
 *
 * `id` carries the standard `uuid_generate_v4()` default (uuid-ossp is enabled
 * by the initial migration) so the atomic `INSERT ... ON CONFLICT` upsert in
 * `UserSyncStateDatabaseService.bump` needs to supply only `userId`. The UNIQUE
 * constraint on `userId` is the ON CONFLICT target and enforces the 1:1.
 */
export class AddUserSyncState1783800000000 implements MigrationInterface {
  name = 'AddUserSyncState1783800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "user_sync_state" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "userId" uuid NOT NULL,
        "revision" bigint NOT NULL DEFAULT 0,
        "changedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_user_sync_state_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_user_sync_state_userId" UNIQUE ("userId"),
        CONSTRAINT "FK_user_sync_state_user" FOREIGN KEY ("userId")
          REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "user_sync_state"`);
  }
}
