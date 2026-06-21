import { Module, Provider, Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { AssistantConfig } from './assistant.config';
import { CommandHandlerService } from './commands/command-handler.service';
import { ContextBuilderService } from './context-builder.service';
import { ScheduleReaderService } from './schedule-reader.service';
import { LAST_BUTTON_STORE } from './session/last-button.store';
import { ToolDispatcherService } from './tools/tool-dispatcher.service';
import { AccessTokenGuard } from '@/guards/access-token.guard';
import { CalendarModule } from '@/modules/calendar/calendar.module';
import { DatabaseModule } from '@/modules/database/database.module';
import {
  CalendarDatabaseService,
  ConversationDatabaseService,
  ConversationMessageDatabaseService,
  ConversationSummaryDatabaseService,
  DeviceDatabaseService,
  NotificationRuleDatabaseService,
  NotificationStrategyDatabaseService,
  PersonaPromptDatabaseService,
  RecurrenceRuleDatabaseService,
  ScheduledNotificationDatabaseService,
  TaskDatabaseService,
  TaskGroupDatabaseService,
  TaskOccurrenceExceptionDatabaseService,
  TelegramLinkDatabaseService,
  UserDatabaseService,
  UserMemoryFactDatabaseService,
} from '@/modules/database/services';
import { TaskModule } from '@/modules/task/task.module';
import { TaskGroupModule } from '@/modules/task-group/task-group.module';

/**
 * Every DatabaseService token DatabaseModule exports. The stub below provides a
 * trivial value for each so the real feature services (TaskService, etc.) wire
 * against them without a live TypeORM connection — this test guards the
 * cross-MODULE wiring (exports/imports), not the DB layer itself.
 */
const DATABASE_SERVICE_TOKENS: Type<unknown>[] = [
  UserDatabaseService,
  DeviceDatabaseService,
  TelegramLinkDatabaseService,
  CalendarDatabaseService,
  TaskGroupDatabaseService,
  TaskDatabaseService,
  RecurrenceRuleDatabaseService,
  TaskOccurrenceExceptionDatabaseService,
  NotificationStrategyDatabaseService,
  NotificationRuleDatabaseService,
  ScheduledNotificationDatabaseService,
  ConversationDatabaseService,
  ConversationMessageDatabaseService,
  ConversationSummaryDatabaseService,
  UserMemoryFactDatabaseService,
  PersonaPromptDatabaseService,
];

/**
 * Builds a stand-in for DatabaseModule that provides + exports the same service
 * tokens as empty objects, so importers resolve without a real DataSource.
 */
const buildDatabaseStubModule = (): Type<unknown> => {
  const providers: Provider[] = DATABASE_SERVICE_TOKENS.map((token) => ({
    provide: token,
    useValue: {},
  }));

  @Module({ providers, exports: DATABASE_SERVICE_TOKENS })
  class DatabaseStubModule {}

  return DatabaseStubModule;
};

const CONFIG_STUB = {
  get: () => 7,
} as unknown as ConfigService;

/**
 * Assembles the assistant's task-facing providers (the new cross-module wiring)
 * against the REAL TaskModule / TaskGroupModule / CalendarModule, so a missing
 * export/import between the assistant and a feature module fails here.
 * `ConfigService` is provided locally (a stub) to satisfy `AssistantConfig`.
 */
@Module({
  imports: [DatabaseModule, TaskModule, TaskGroupModule, CalendarModule],
  providers: [
    { provide: ConfigService, useValue: CONFIG_STUB },
    AssistantConfig,
    ScheduleReaderService,
    // The context builder reads the latest-button line through the narrow read
    // port (Story 16 / ADR 0045). The real LastButtonStore needs the shared Redis
    // client, which this hermetic harness deliberately omits; a trivial value stub
    // for the token keeps the wiring guard focused on the cross-MODULE graph.
    { provide: LAST_BUTTON_STORE, useValue: { takeLatest: () => null } },
    ContextBuilderService,
    ToolDispatcherService,
    CommandHandlerService,
  ],
})
class AssistantWiringHarnessModule {}

describe('AssistantModule cross-module wiring (DI graph)', () => {
  // NOTE: the full AssistantModule also pulls in the BullMQ root + queue, the
  // shared Redis client, and the three SDK-backed connectors (ai/stt/vendor),
  // which need a live TypeORM root connection to even register forFeature repos.
  // To keep this a fast, hermetic guard we exercise the NEW wiring — the
  // task-domain tool dispatcher + context builder against the real feature
  // modules — with the DB layer stubbed. It still fails if the assistant stops
  // importing TaskModule/TaskGroupModule or a feature module stops exporting its
  // service (the wiring-break class that all current mocked unit tests miss).
  it('resolves ToolDispatcherService and ContextBuilderService from the real feature-module graph', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AssistantWiringHarnessModule],
    })
      .overrideModule(DatabaseModule)
      .useModule(buildDatabaseStubModule())
      // Feature controllers bind AccessTokenGuard (→ JwtService from AuthModule);
      // we only need the service graph, so neutralize the guard.
      .overrideGuard(AccessTokenGuard)
      .useValue({ canActivate: () => true })
      .compile();

    expect(moduleRef.get(ToolDispatcherService)).toBeInstanceOf(
      ToolDispatcherService,
    );
    expect(moduleRef.get(ContextBuilderService)).toBeInstanceOf(
      ContextBuilderService,
    );

    await moduleRef.close();
  });
});
