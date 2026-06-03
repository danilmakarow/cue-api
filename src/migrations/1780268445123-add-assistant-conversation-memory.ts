import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the Telegram AI assistant's conversation + memory tables (ADR 0005):
 * `conversation` (1:1 with user), `conversation_message`, `conversation_summary`,
 * and `user_memory_fact`. UUID PKs, `timestamptz` everywhere, enum types named
 * `<table>_<column>_enum` to match the initial schema, FKs cascading from
 * `user`/`conversation`, and the indexes that serve the recent-window and
 * relevant-subset queries.
 */
export class AddAssistantConversationMemory1780268445123 implements MigrationInterface {
  name = 'AddAssistantConversationMemory1780268445123';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Enums
    await queryRunner.query(
      `CREATE TYPE "public"."conversation_message_role_enum" AS ENUM('user', 'assistant', 'tool', 'synthetic')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."conversation_message_contenttype_enum" AS ENUM('text', 'voice_transcript', 'command_result')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."user_memory_fact_type_enum" AS ENUM('working_hours', 'no_go_window', 'recurring_commitment', 'preference', 'person', 'place', 'other')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."user_memory_fact_source_enum" AS ENUM('inferred', 'explicit')`,
    );

    // conversation — 1:1 with user
    await queryRunner.query(
      `CREATE TABLE "conversation" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "userId" uuid NOT NULL,
        "lastActivityAt" TIMESTAMP WITH TIME ZONE,
        "latestSummaryId" uuid,
        CONSTRAINT "UQ_conversation_userId" UNIQUE ("userId"),
        CONSTRAINT "PK_conversation_id" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" ADD CONSTRAINT "FK_conversation_userId" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // conversation_message — many per conversation
    await queryRunner.query(
      `CREATE TABLE "conversation_message" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "conversationId" uuid NOT NULL,
        "role" "public"."conversation_message_role_enum" NOT NULL,
        "contentType" "public"."conversation_message_contenttype_enum" NOT NULL DEFAULT 'text',
        "content" text NOT NULL,
        "toolPayload" jsonb,
        "vendorMessageId" bigint,
        "tokenCount" integer,
        CONSTRAINT "PK_conversation_message_id" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_message" ADD CONSTRAINT "FK_conversation_message_conversationId" FOREIGN KEY ("conversationId") REFERENCES "conversation"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_conversation_message_conversationId_createdAt" ON "conversation_message" ("conversationId", "createdAt")`,
    );

    // conversation_summary — many per conversation
    await queryRunner.query(
      `CREATE TABLE "conversation_summary" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "conversationId" uuid NOT NULL,
        "summaryText" text NOT NULL,
        "coversUpToMessageId" uuid NOT NULL,
        "tokenCount" integer,
        CONSTRAINT "PK_conversation_summary_id" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_summary" ADD CONSTRAINT "FK_conversation_summary_conversationId" FOREIGN KEY ("conversationId") REFERENCES "conversation"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_conversation_summary_conversationId_createdAt" ON "conversation_summary" ("conversationId", "createdAt")`,
    );

    // user_memory_fact — many per user
    await queryRunner.query(
      `CREATE TABLE "user_memory_fact" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "userId" uuid NOT NULL,
        "type" "public"."user_memory_fact_type_enum" NOT NULL,
        "key" character varying NOT NULL,
        "value" jsonb NOT NULL,
        "confidence" numeric(4,3) NOT NULL DEFAULT '1',
        "source" "public"."user_memory_fact_source_enum" NOT NULL DEFAULT 'inferred',
        CONSTRAINT "PK_user_memory_fact_id" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_memory_fact" ADD CONSTRAINT "FK_user_memory_fact_userId" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_user_memory_fact_userId_type" ON "user_memory_fact" ("userId", "type")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_user_memory_fact_userId_type"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_memory_fact" DROP CONSTRAINT "FK_user_memory_fact_userId"`,
    );
    await queryRunner.query(`DROP TABLE "user_memory_fact"`);

    await queryRunner.query(
      `DROP INDEX "public"."IDX_conversation_summary_conversationId_createdAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_summary" DROP CONSTRAINT "FK_conversation_summary_conversationId"`,
    );
    await queryRunner.query(`DROP TABLE "conversation_summary"`);

    await queryRunner.query(
      `DROP INDEX "public"."IDX_conversation_message_conversationId_createdAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_message" DROP CONSTRAINT "FK_conversation_message_conversationId"`,
    );
    await queryRunner.query(`DROP TABLE "conversation_message"`);

    await queryRunner.query(
      `ALTER TABLE "conversation" DROP CONSTRAINT "FK_conversation_userId"`,
    );
    await queryRunner.query(`DROP TABLE "conversation"`);

    await queryRunner.query(
      `DROP TYPE "public"."user_memory_fact_source_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."user_memory_fact_type_enum"`);
    await queryRunner.query(
      `DROP TYPE "public"."conversation_message_contenttype_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."conversation_message_role_enum"`,
    );
  }
}
