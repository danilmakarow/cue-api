import { createHash } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Redis } from 'ioredis';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { CapturingVendorConnector } from './capturing-vendor.connector';
import { ScriptedAiConnector } from './scripted-ai.connector';
import { AppModule } from '@/app.module';
import { ACTIVE_AI_CONNECTOR } from '@/modules/ai/ai.module';
import { AnthropicAiConnector } from '@/modules/ai/anthropic/anthropic-ai.connector';
import { Calendar, TelegramLink, User } from '@/modules/database/entities';
import {
  CalendarDatabaseService,
  TelegramLinkDatabaseService,
  UserDatabaseService,
} from '@/modules/database/services';
import { ExternalVendorConfig } from '@/modules/external-vendor/external-vendor.config';
import { TelegramVendorConnector } from '@/modules/external-vendor/telegram/telegram-vendor.connector';
import { REDIS_CLIENT } from '@/modules/redis/redis.module';

/**
 * Mutable tables truncated between tests so each scenario starts from a clean
 * slate. `RESTART IDENTITY CASCADE` also clears anything FK-referencing these.
 * Quoted because `user` is a reserved word in Postgres.
 */
const TRUNCATABLE_TABLES = [
  'task',
  'pending_question',
  'conversation_message',
  'conversation_summary',
  'conversation',
  'telegram_link',
  'task_occurrence_exception',
  'task_group',
  'recurrence_rule',
  'notification_rule',
  'notification_strategy',
  'scheduled_notification',
  'device',
  'user_memory_fact',
  'calendar',
  '"user"',
];

/** A minimal Telegram message update body the connector's ingress accepts. */
export interface TelegramTextUpdate {
  update_id: number;
  message: {
    message_id: number;
    chat: { id: number };
    from: { id: number };
    text: string;
  };
}

/** A minimal Telegram callback-query update body (inline button tap). */
export interface TelegramCallbackUpdate {
  update_id: number;
  callback_query: {
    id: string;
    from: { id: number };
    message: { message_id: number; chat: { id: number } };
    data: string;
  };
}

/** The seeded fixtures the consumer needs to resolve + place a write. */
export interface SeededFixtures {
  user: User;
  calendar: Calendar;
  link: TelegramLink;
  chatId: string;
}

/** Counter so every minted update_id (and thus queue jobId) is unique per run. */
let updateIdCounter = 1_000_000;

/**
 * The booted real-pipeline e2e harness. Owns the Nest application (with the full
 * AppModule graph, so the BullMQ worker runs in-process), the overridden vendor
 * + AI seams, the live Postgres DataSource, and the shared ioredis client.
 */
export class E2eHarness {
  private constructor(
    readonly app: INestApplication,
    readonly moduleRef: TestingModule,
    readonly vendor: CapturingVendorConnector,
    readonly scriptedAi: ScriptedAiConnector,
    readonly dataSource: DataSource,
    readonly redis: Redis,
  ) {}

  /**
   * Boots the whole app via `Test.createTestingModule({ imports: [AppModule] })`
   * → `createNestApplication()` → `app.init()`. `init()` (not just `compile()`)
   * is required so `OnModuleInit` fires and `@nestjs/bullmq` starts the real
   * in-process Worker bound to the `assistant-webhook` queue — making the posted
   * webhook actually process down the prod path. Overrides only the two leaf
   * connectors before compile: the Telegram vendor (captured, but real ingress)
   * and the AI connector (deterministic by default; pass `useRealLlm` to keep the
   * real `AnthropicAiConnector` for the opt-in smokes). DB migrations run on boot
   * (`DB_RUN_MIGRATIONS=true`).
   */
  static async boot(options?: { useRealLlm?: boolean }): Promise<E2eHarness> {
    const scriptedAi = new ScriptedAiConnector();

    let builder = Test.createTestingModule({ imports: [AppModule] });

    // Capture outbound vendor calls while keeping real ingress (acceptWebhook +
    // handleWebhook). Overriding the single concrete connector points both the
    // factory and the ACTIVE_VENDOR_CONNECTOR token at this instance.
    builder = builder.overrideProvider(TelegramVendorConnector).useFactory({
      inject: [ExternalVendorConfig],
      factory: (config: ExternalVendorConfig) =>
        new CapturingVendorConnector(config),
    });

    // Deterministic AI unless the test opts into the real connector. Both the
    // active token AND the concrete class must be overridden: the orchestrator
    // injects ACTIVE_AI_CONNECTOR, while AiModule's useFactory builds it from the
    // AiConnectorFactory (which depends on the concrete AnthropicAiConnector).
    if (!options?.useRealLlm) {
      builder = builder
        .overrideProvider(ACTIVE_AI_CONNECTOR)
        .useValue(scriptedAi)
        .overrideProvider(AnthropicAiConnector)
        .useValue(scriptedAi);
    }

    const moduleRef = await builder.compile();
    const app = moduleRef.createNestApplication();

    await app.init();

    const vendor = moduleRef.get(TelegramVendorConnector);

    if (!(vendor instanceof CapturingVendorConnector)) {
      throw new Error(
        'E2eHarness: TelegramVendorConnector override did not resolve to the capturing fake.',
      );
    }

    const dataSource = moduleRef.get(DataSource);
    const redis = moduleRef.get<Redis>(REDIS_CLIENT);

    return new E2eHarness(
      app,
      moduleRef,
      vendor,
      scriptedAi,
      dataSource,
      redis,
    );
  }

  /**
   * Truncates the mutable tables and flushes the dedicated Redis DB so the
   * dedupe / held keys never leak across tests, then resets the captured-send
   * log and the AI script. Call in `afterEach`.
   */
  async reset(): Promise<void> {
    await this.dataSource.query(
      `TRUNCATE TABLE ${TRUNCATABLE_TABLES.join(', ')} RESTART IDENTITY CASCADE`,
    );
    await this.redis.flushdb();
    this.vendor.reset();
    this.scriptedAi.reset();
  }

  /**
   * Seeds the minimum the consumer needs for a linked turn: a User, that user's
   * primary Calendar (resolved by `findPrimaryForOwner` when a write omits a
   * calendar), and a TelegramLink whose `telegramChatId` equals the chat id used
   * in the webhook body (`findByTelegramChatId`). Seeds via the same
   * `*DatabaseService.save()` path the app uses.
   */
  async seedLinkedUser(chatId = '555000111'): Promise<SeededFixtures> {
    const userDb = this.moduleRef.get(UserDatabaseService);
    const calendarDb = this.moduleRef.get(CalendarDatabaseService);
    const linkDb = this.moduleRef.get(TelegramLinkDatabaseService);

    const user = await userDb.save(
      userDb.createInstance({
        appleUserId: `e2e-apple-${chatId}`,
        email: `e2e-${chatId}@example.test`,
        displayName: 'Tony',
        timezone: 'UTC',
      }),
    );

    const calendar = await calendarDb.save(
      calendarDb.createInstance({
        ownerId: user.id,
        name: 'Personal',
        sortOrder: 0,
      }),
    );

    const link = await linkDb.save(
      linkDb.createInstance({
        userId: user.id,
        telegramChatId: chatId,
        telegramUsername: 'tony',
        linkedAt: new Date(),
      }),
    );

    return { user, calendar, link, chatId };
  }

  /**
   * Builds a unique-`update_id` Telegram text update for the given chat. A fresh
   * id per call keeps the queue jobId (sha256(body)) and the consumer's Redis
   * dedupe from collapsing an otherwise-identical resend.
   */
  buildTextUpdate(chatId: string, text: string): TelegramTextUpdate {
    updateIdCounter += 1;

    return {
      update_id: updateIdCounter,
      message: {
        message_id: updateIdCounter,
        chat: { id: Number(chatId) },
        from: { id: Number(chatId) },
        text,
      },
    };
  }

  /**
   * Builds a unique-`update_id` Telegram callback-query update (inline button
   * tap) carrying the given callback data, for the held-conflict confirm flow.
   */
  buildCallbackUpdate(
    chatId: string,
    callbackData: string,
  ): TelegramCallbackUpdate {
    updateIdCounter += 1;

    return {
      update_id: updateIdCounter,
      callback_query: {
        id: `cb-${updateIdCounter}`,
        from: { id: Number(chatId) },
        message: { message_id: updateIdCounter, chat: { id: Number(chatId) } },
        data: callbackData,
      },
    };
  }

  /**
   * POSTs a Telegram update to the real webhook controller with the valid
   * secret-token header, asserting the synchronous 200 + `{ ok: true }`. The turn
   * then runs in the in-process worker; await `harness.vendor.nextSend()` for the
   * reply. Returns the predicted queue jobId (sha256 of the JSON body) so a test
   * can correlate via QueueEvents if needed.
   */
  async postWebhook(
    update: TelegramTextUpdate | TelegramCallbackUpdate,
  ): Promise<{ jobId: string }> {
    const bodyString = JSON.stringify(update);
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? '';

    await request(this.app.getHttpServer())
      .post('/assistant/telegram/webhook')
      .set('x-telegram-bot-api-secret-token', secret)
      .send(update)
      .expect(200)
      .expect({ ok: true });

    const jobId = createHash('sha256').update(bodyString).digest('hex');

    return { jobId };
  }

  /**
   * Counts task rows in a given calendar (default: all), bypassing the soft-delete
   * filter is unnecessary — created tasks are not soft-deleted, so a plain count
   * reflects committed creates.
   */
  async countTasks(calendarId?: string): Promise<number> {
    const where = calendarId ? 'WHERE "calendarId" = $1' : '';
    const params = calendarId ? [calendarId] : [];
    const rows: Array<{ count: number }> = await this.dataSource.query(
      `SELECT COUNT(*)::int AS count FROM task ${where}`,
      params,
    );

    return rows[0]?.count ?? 0;
  }

  /**
   * Returns the task rows in a calendar ordered by creation, for content
   * assertions (title, startAt). Raw SQL keeps the helper free of the 3-layer
   * data-access constraints that bind feature code (tests read directly).
   */
  async listTasks(
    calendarId: string,
  ): Promise<Array<{ title: string; startAt: string | null }>> {
    const rows: Array<{ title: string; startAt: string | null }> =
      await this.dataSource.query(
        `SELECT title, "startAt" FROM task WHERE "calendarId" = $1 ORDER BY "createdAt" ASC`,
        [calendarId],
      );

    return rows;
  }

  /**
   * Returns the persisted tool-step audit rows (`role = 'tool'`) for assertions
   * on the orchestrator's forensic trail (e.g. the narration `correctionReason`).
   */
  async listToolAuditRows(): Promise<
    Array<{ content: string; toolPayload: Record<string, unknown> | null }>
  > {
    const rows: Array<{
      content: string;
      toolPayload: Record<string, unknown> | null;
    }> = await this.dataSource.query(
      `SELECT content, "toolPayload" FROM conversation_message WHERE role = 'tool' ORDER BY "createdAt" ASC`,
    );

    return rows;
  }

  /**
   * Returns the held-conflict Redis keys currently set (`assistant:held:*`), so a
   * test can assert a write was parked (and read its TTL) without knowing the token.
   */
  async heldConflictKeys(): Promise<string[]> {
    return this.redis.keys('assistant:held:*');
  }

  /**
   * Returns the pending-`ask_user` rows (ADR 0010) for assertions on the
   * suspend/resume round-trip: the row id (for building the `ask:<id>:<opt>`
   * callback), its status, and the ask `tool_use` id. Raw SQL keeps the helper
   * free of the 3-layer data-access constraints that bind feature code.
   */
  async listPendingQuestions(): Promise<
    Array<{ id: string; status: string; askToolUseId: string }>
  > {
    return this.dataSource.query(
      `SELECT id, status, "askToolUseId" FROM pending_question ORDER BY "createdAt" ASC`,
    );
  }

  /**
   * Returns the hot pending-question Redis keys currently set (`assistant:ask:*`),
   * so a test can assert the hot index was mirrored on suspend and cleared on
   * resume.
   */
  async pendingQuestionKeys(): Promise<string[]> {
    return this.redis.keys('assistant:ask:*');
  }

  /**
   * Drains a tiny tail of the event loop so any post-reply background work
   * (summarizer / memory extractor fire-and-forget) settles before the next test
   * truncates — avoiding open-handle warnings and mid-truncation races.
   */
  async settleBackground(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  /**
   * Closes the Nest app (stopping the in-process BullMQ worker via its
   * OnApplicationShutdown hook and tearing down TypeORM), then explicitly quits
   * the shared ioredis client. The `REDIS_CLIENT` provider has no shutdown hook
   * of its own, so without this quit the open socket would leak as a jest
   * open-handle. `quit()` is best-effort — a double-quit / already-closed client
   * is swallowed so teardown never throws.
   */
  async close(): Promise<void> {
    await this.app.close();

    try {
      await this.redis.quit();
    } catch {
      // client already disconnected — nothing to do
    }
  }
}
