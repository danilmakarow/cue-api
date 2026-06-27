import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AssistantWebhookController } from './assistant-webhook.controller';
import { AssistantConfig } from './assistant.config';
import { AssistantService } from './assistant.service';
import { MemoryExtractorService } from './background/memory-extractor.service';
import { RoundRecapService } from './background/round-recap.service';
import { SummarizerService } from './background/summarizer.service';
import { CommandHandlerService } from './commands/command-handler.service';
import { KeyboardActionService } from './commands/keyboard-action.service';
import { ContextBuilderService } from './context-builder.service';
import { DebounceConsumer } from './debounce.consumer';
import { LinkingService } from './linking.service';
import { ToolLoopService } from './orchestration/tool-loop.service';
import { ParseService } from './parse.service';
import { ReplyPresenter } from './reply/reply-presenter.service';
import { StatusAnimatorService } from './reply/status-animator.service';
import { StatusSessionStore } from './reply/status-session.store';
import { ScheduleReaderService } from './schedule-reader.service';
import { ActiveKeyboardStore } from './session/active-keyboard.store';
import { ConversationStore } from './session/conversation.store';
import { DebounceCoordinatorService } from './session/debounce-coordinator.service';
import {
  LAST_BUTTON_STORE,
  LastButtonStore,
} from './session/last-button.store';
import { LastMenuStore } from './session/last-menu.store';
import { LastMessageLanguageStore } from './session/last-message-language.store';
import { MessageBufferStore } from './session/message-buffer.store';
import {
  PENDING_INTERACTION_STORE,
  PendingInteractionService,
} from './session/pending-interaction.store';
import { PendingQuestionCleanupService } from './session/pending-question-cleanup.service';
import { TurnAuditStore } from './session/turn-audit.store';
import { TurnRunnerService } from './session/turn-runner.service';
import { UserLockStore } from './session/user-lock.store';
import { ToolDispatcherService } from './tools/tool-dispatcher.service';
import { WebhookRegistrarService } from './webhook-registrar.service';
import { WebhookConsumer } from './webhook.consumer';
import {
  DEBOUNCE_QUEUE_NAME,
  WEBHOOK_QUEUE_NAME,
} from '../redis/redis.constants';
import { AiModule } from '@/modules/ai/ai.module';
import { AlertModule } from '@/modules/alert/alert.module';
import { CalendarModule } from '@/modules/calendar/calendar.module';
import { DatabaseModule } from '@/modules/database/database.module';
import { ExternalVendorModule } from '@/modules/external-vendor/external-vendor.module';
import { SttModule } from '@/modules/stt/stt.module';
import { TaskModule } from '@/modules/task/task.module';
import { TaskGroupModule } from '@/modules/task-group/task-group.module';

/**
 * The Telegram AI assistant feature module. Wires the webhook ingress + its
 * durable BullMQ queue, the consumer that runs the inbound pipeline, the
 * orchestrator and its context builder / tool dispatcher / commands / linking /
 * background jobs, consuming the three provider-agnostic connectors (vendor, AI,
 * STT) and the existing feature services for calendar reads/writes.
 */
@Module({
  imports: [
    DatabaseModule,
    TaskModule,
    TaskGroupModule,
    CalendarModule,
    ExternalVendorModule,
    AiModule,
    AlertModule,
    SttModule,
    BullModule.registerQueue({
      name: WEBHOOK_QUEUE_NAME,
      // attempts:1 overrides the global attempts:5 default (app.module.ts) for
      // THIS queue only — the inbound pipeline is non-idempotent, so a replayed
      // turn re-runs committed create_task/create_tasks writes and double-books
      // (ADR-0026). No backoff is meaningful at a single attempt. The controller
      // ALSO passes attempts:1 per-job as the guaranteed override; removeOnFail
      // (false) / removeOnComplete (true) intentionally inherit the global.
      defaultJobOptions: { attempts: 1 },
    }),
    BullModule.registerQueue({
      // The per-user debounce-drain queue (Story 14a / ADR 0042). attempts:1 for
      // the same reason as the webhook queue — a drained turn commits
      // non-idempotent calendar writes, so a replay would double-book (ADR-0026).
      // The coordinator degrades never-throw and re-buffers on fault, so a single
      // attempt never loses the batch. A stable per-user jobId means a re-armed
      // window replaces the pending delayed job rather than stacking duplicates.
      name: DEBOUNCE_QUEUE_NAME,
      defaultJobOptions: { attempts: 1 },
    }),
  ],
  controllers: [AssistantWebhookController],
  providers: [
    AssistantConfig,
    ReplyPresenter,
    StatusSessionStore,
    StatusAnimatorService,
    ScheduleReaderService,
    ContextBuilderService,
    ToolDispatcherService,
    ToolLoopService,
    CommandHandlerService,
    KeyboardActionService,
    ActiveKeyboardStore,
    LastButtonStore,
    {
      // The context builder reads the latest-button line through the narrow
      // read port; the keyboard-action handler writes it through the concrete
      // store. Both resolve to the SAME LastButtonStore instance so the
      // overwrite-on-write / read-then-clear pair shares one Redis keyspace
      // (Story 16 / ADR 0045).
      provide: LAST_BUTTON_STORE,
      useExisting: LastButtonStore,
    },
    LastMessageLanguageStore,
    LastMenuStore,
    LinkingService,
    ParseService,
    SummarizerService,
    MemoryExtractorService,
    RoundRecapService,
    AssistantService,
    TurnRunnerService,
    ConversationStore,
    TurnAuditStore,
    PendingInteractionService,
    PendingQuestionCleanupService,
    UserLockStore,
    MessageBufferStore,
    DebounceCoordinatorService,
    {
      // The router's read port and the orchestrator's write side are the SAME
      // instance — the token aliases the concrete service so `hasPendingQuestion`
      // (router) and `createPendingQuestion` / claims (orchestrator) share state.
      provide: PENDING_INTERACTION_STORE,
      useExisting: PendingInteractionService,
    },
    WebhookConsumer,
    DebounceConsumer,
    WebhookRegistrarService,
  ],
})
export class AssistantModule {}
