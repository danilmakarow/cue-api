import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Initial Cue schema migration — creates all core tables with UUID primary keys,
 * enum types, foreign keys, and indexes that serve the planner's access patterns.
 */
export class InitialSchema1776546898362 implements MigrationInterface {
  name = 'InitialSchema1776546898362';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Ensure uuid generation is available.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // Enums
    await queryRunner.query(
      `CREATE TYPE "public"."device_platform_enum" AS ENUM('ios', 'ipados', 'macos')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."recurrence_rule_frequency_enum" AS ENUM('DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."recurrence_rule_endtype_enum" AS ENUM('NEVER', 'UNTIL_DATE', 'COUNT')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."notification_rule_channel_enum" AS ENUM('PUSH', 'TELEGRAM')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."scheduled_notification_channel_enum" AS ENUM('PUSH', 'TELEGRAM')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."scheduled_notification_status_enum" AS ENUM('PENDING', 'SENT', 'FAILED', 'CANCELLED')`,
    );

    // user
    await queryRunner.query(
      `CREATE TABLE "user" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "appleUserId" character varying NOT NULL,
        "email" character varying,
        "displayName" character varying,
        "timezone" character varying NOT NULL DEFAULT 'UTC',
        CONSTRAINT "UQ_user_appleUserId" UNIQUE ("appleUserId"),
        CONSTRAINT "PK_user_id" PRIMARY KEY ("id")
      )`,
    );

    // device
    await queryRunner.query(
      `CREATE TABLE "device" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "userId" uuid NOT NULL,
        "apnsToken" character varying NOT NULL,
        "platform" "public"."device_platform_enum" NOT NULL,
        "lastSeenAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "UQ_device_apnsToken" UNIQUE ("apnsToken"),
        CONSTRAINT "PK_device_id" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `ALTER TABLE "device" ADD CONSTRAINT "FK_device_userId" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // telegram_link
    await queryRunner.query(
      `CREATE TABLE "telegram_link" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "userId" uuid NOT NULL,
        "telegramChatId" bigint NOT NULL,
        "telegramUsername" character varying,
        "linkedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "UQ_telegram_link_userId" UNIQUE ("userId"),
        CONSTRAINT "PK_telegram_link_id" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `ALTER TABLE "telegram_link" ADD CONSTRAINT "FK_telegram_link_userId" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // calendar
    await queryRunner.query(
      `CREATE TABLE "calendar" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "ownerId" uuid NOT NULL,
        "name" character varying NOT NULL,
        "color" character varying,
        "icon" character varying,
        "sortOrder" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_calendar_id" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_calendar_ownerId" ON "calendar" ("ownerId")`,
    );
    await queryRunner.query(
      `ALTER TABLE "calendar" ADD CONSTRAINT "FK_calendar_ownerId" FOREIGN KEY ("ownerId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // notification_strategy
    await queryRunner.query(
      `CREATE TABLE "notification_strategy" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "calendarId" uuid NOT NULL,
        "name" character varying NOT NULL,
        CONSTRAINT "PK_notification_strategy_id" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_notification_strategy_calendarId" ON "notification_strategy" ("calendarId")`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification_strategy" ADD CONSTRAINT "FK_notification_strategy_calendarId" FOREIGN KEY ("calendarId") REFERENCES "calendar"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // notification_rule
    await queryRunner.query(
      `CREATE TABLE "notification_rule" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "strategyId" uuid NOT NULL,
        "offsetMinutes" integer NOT NULL,
        "channel" "public"."notification_rule_channel_enum" NOT NULL,
        "messageTemplate" text,
        CONSTRAINT "PK_notification_rule_id" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification_rule" ADD CONSTRAINT "FK_notification_rule_strategyId" FOREIGN KEY ("strategyId") REFERENCES "notification_strategy"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // task_group
    await queryRunner.query(
      `CREATE TABLE "task_group" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "calendarId" uuid NOT NULL,
        "name" character varying NOT NULL,
        "color" character varying,
        "icon" character varying,
        "defaultNotificationStrategyId" uuid,
        "sortOrder" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_task_group_id" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_task_group_calendarId" ON "task_group" ("calendarId")`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_group" ADD CONSTRAINT "FK_task_group_calendarId" FOREIGN KEY ("calendarId") REFERENCES "calendar"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_group" ADD CONSTRAINT "FK_task_group_defaultNotificationStrategyId" FOREIGN KEY ("defaultNotificationStrategyId") REFERENCES "notification_strategy"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );

    // recurrence_rule
    await queryRunner.query(
      `CREATE TABLE "recurrence_rule" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "frequency" "public"."recurrence_rule_frequency_enum" NOT NULL,
        "interval" integer NOT NULL DEFAULT 1,
        "byWeekday" integer array,
        "byMonthDay" integer array,
        "byMonth" integer array,
        "endType" "public"."recurrence_rule_endtype_enum" NOT NULL DEFAULT 'NEVER',
        "endDate" date,
        "count" integer,
        CONSTRAINT "PK_recurrence_rule_id" PRIMARY KEY ("id")
      )`,
    );

    // task
    await queryRunner.query(
      `CREATE TABLE "task" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "calendarId" uuid NOT NULL,
        "groupId" uuid,
        "title" character varying NOT NULL,
        "notes" text,
        "startAt" TIMESTAMP WITH TIME ZONE,
        "endAt" TIMESTAMP WITH TIME ZONE,
        "isAllDay" boolean NOT NULL DEFAULT false,
        "timezone" character varying NOT NULL,
        "requiresCompletion" boolean NOT NULL DEFAULT true,
        "completedAt" TIMESTAMP WITH TIME ZONE,
        "notificationStrategyId" uuid,
        "recurrenceRuleId" uuid,
        "deletedAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_task_id" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_task_calendarId_startAt" ON "task" ("calendarId", "startAt")`,
    );
    await queryRunner.query(
      `ALTER TABLE "task" ADD CONSTRAINT "FK_task_calendarId" FOREIGN KEY ("calendarId") REFERENCES "calendar"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "task" ADD CONSTRAINT "FK_task_groupId" FOREIGN KEY ("groupId") REFERENCES "task_group"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "task" ADD CONSTRAINT "FK_task_notificationStrategyId" FOREIGN KEY ("notificationStrategyId") REFERENCES "notification_strategy"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "task" ADD CONSTRAINT "FK_task_recurrenceRuleId" FOREIGN KEY ("recurrenceRuleId") REFERENCES "recurrence_rule"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );

    // task_occurrence_exception
    await queryRunner.query(
      `CREATE TABLE "task_occurrence_exception" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "taskId" uuid NOT NULL,
        "originalStartAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "isSkipped" boolean NOT NULL DEFAULT false,
        "overrideStartAt" TIMESTAMP WITH TIME ZONE,
        "overrideEndAt" TIMESTAMP WITH TIME ZONE,
        "overrideTitle" character varying,
        "completedAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "UQ_task_occurrence_exception_taskId_originalStartAt" UNIQUE ("taskId", "originalStartAt"),
        CONSTRAINT "PK_task_occurrence_exception_id" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_occurrence_exception" ADD CONSTRAINT "FK_task_occurrence_exception_taskId" FOREIGN KEY ("taskId") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // scheduled_notification
    await queryRunner.query(
      `CREATE TABLE "scheduled_notification" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "userId" uuid NOT NULL,
        "taskId" uuid NOT NULL,
        "occurrenceStartAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "fireAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "channel" "public"."scheduled_notification_channel_enum" NOT NULL,
        "status" "public"."scheduled_notification_status_enum" NOT NULL DEFAULT 'PENDING',
        "attemptCount" integer NOT NULL DEFAULT 0,
        "sentAt" TIMESTAMP WITH TIME ZONE,
        "error" text,
        CONSTRAINT "PK_scheduled_notification_id" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_scheduled_notification_status_fireAt" ON "scheduled_notification" ("status", "fireAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_scheduled_notification_fireAt" ON "scheduled_notification" ("fireAt")`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_notification" ADD CONSTRAINT "FK_scheduled_notification_userId" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_notification" ADD CONSTRAINT "FK_scheduled_notification_taskId" FOREIGN KEY ("taskId") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "scheduled_notification" DROP CONSTRAINT "FK_scheduled_notification_taskId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_notification" DROP CONSTRAINT "FK_scheduled_notification_userId"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_scheduled_notification_fireAt"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_scheduled_notification_status_fireAt"`,
    );
    await queryRunner.query(`DROP TABLE "scheduled_notification"`);

    await queryRunner.query(
      `ALTER TABLE "task_occurrence_exception" DROP CONSTRAINT "FK_task_occurrence_exception_taskId"`,
    );
    await queryRunner.query(`DROP TABLE "task_occurrence_exception"`);

    await queryRunner.query(
      `ALTER TABLE "task" DROP CONSTRAINT "FK_task_recurrenceRuleId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "task" DROP CONSTRAINT "FK_task_notificationStrategyId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "task" DROP CONSTRAINT "FK_task_groupId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "task" DROP CONSTRAINT "FK_task_calendarId"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_task_calendarId_startAt"`,
    );
    await queryRunner.query(`DROP TABLE "task"`);

    await queryRunner.query(`DROP TABLE "recurrence_rule"`);

    await queryRunner.query(
      `ALTER TABLE "task_group" DROP CONSTRAINT "FK_task_group_defaultNotificationStrategyId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_group" DROP CONSTRAINT "FK_task_group_calendarId"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_task_group_calendarId"`);
    await queryRunner.query(`DROP TABLE "task_group"`);

    await queryRunner.query(
      `ALTER TABLE "notification_rule" DROP CONSTRAINT "FK_notification_rule_strategyId"`,
    );
    await queryRunner.query(`DROP TABLE "notification_rule"`);

    await queryRunner.query(
      `ALTER TABLE "notification_strategy" DROP CONSTRAINT "FK_notification_strategy_calendarId"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_notification_strategy_calendarId"`,
    );
    await queryRunner.query(`DROP TABLE "notification_strategy"`);

    await queryRunner.query(
      `ALTER TABLE "calendar" DROP CONSTRAINT "FK_calendar_ownerId"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_calendar_ownerId"`);
    await queryRunner.query(`DROP TABLE "calendar"`);

    await queryRunner.query(
      `ALTER TABLE "telegram_link" DROP CONSTRAINT "FK_telegram_link_userId"`,
    );
    await queryRunner.query(`DROP TABLE "telegram_link"`);

    await queryRunner.query(
      `ALTER TABLE "device" DROP CONSTRAINT "FK_device_userId"`,
    );
    await queryRunner.query(`DROP TABLE "device"`);

    await queryRunner.query(`DROP TABLE "user"`);

    await queryRunner.query(
      `DROP TYPE "public"."scheduled_notification_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."scheduled_notification_channel_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."notification_rule_channel_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."recurrence_rule_endtype_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."recurrence_rule_frequency_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."device_platform_enum"`);
  }
}
