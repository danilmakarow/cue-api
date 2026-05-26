import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `avatarBase64` (nullable text) to `user` — stores the profile picture
 * collected by the iOS client at sign-in and rendered in the calendar header.
 */
export class AddUserAvatar1776718931021 implements MigrationInterface {
  name = 'AddUserAvatar1776718931021';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user" ADD COLUMN "avatarBase64" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "avatarBase64"`);
  }
}
