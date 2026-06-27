import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the cross-device notification opt-in columns to `user` (backlog D8):
 * `morningBriefEnabled` and `eveningRecapEnabled`, both `boolean NOT NULL DEFAULT
 * true` so existing rows keep the briefs on by default. Onboarding-completion is
 * deliberately NOT persisted server-side (stays iOS-local `@AppStorage`).
 */
export class AddUserNotificationPrefs1783400000000 implements MigrationInterface {
  name = 'AddUserNotificationPrefs1783400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user" ADD "morningBriefEnabled" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "user" ADD "eveningRecapEnabled" boolean NOT NULL DEFAULT true`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user" DROP COLUMN "eveningRecapEnabled"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user" DROP COLUMN "morningBriefEnabled"`,
    );
  }
}
