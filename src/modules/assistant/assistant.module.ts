import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AssistantWebhookController } from './assistant-webhook.controller';
import { AssistantConfig } from './assistant.config';
import { AssistantService } from './assistant.service';
import { MemoryExtractorService } from './background/memory-extractor.service';
import { SummarizerService } from './background/summarizer.service';
import { CommandHandlerService } from './commands/command-handler.service';
import { ContextBuilderService } from './context-builder.service';
import { LinkingService } from './linking.service';
import { ScheduleReaderService } from './schedule-reader.service';
import {
  PENDING_INTERACTION_STORE,
  PendingInteractionService,
} from './session/pending-interaction.store';
import { PendingQuestionCleanupService } from './session/pending-question-cleanup.service';
import { TurnRunnerService } from './session/turn-runner.service';
import { ToolDispatcherService } from './tools/tool-dispatcher.service';
import { WebhookRegistrarService } from './webhook-registrar.service';
import { WebhookConsumer } from './webhook.consumer';
import { WEBHOOK_QUEUE_NAME } from '../redis/redis.constants';
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
  ],
  controllers: [AssistantWebhookController],
  providers: [
    AssistantConfig,
    ScheduleReaderService,
    ContextBuilderService,
    ToolDispatcherService,
    CommandHandlerService,
    LinkingService,
    SummarizerService,
    MemoryExtractorService,
    AssistantService,
    TurnRunnerService,
    PendingInteractionService,
    PendingQuestionCleanupService,
    {
      // The router's read port and the orchestrator's write side are the SAME
      // instance — the token aliases the concrete service so `hasPendingQuestion`
      // (router) and `createPendingQuestion` / claims (orchestrator) share state.
      provide: PENDING_INTERACTION_STORE,
      useExisting: PendingInteractionService,
    },
    WebhookConsumer,
    WebhookRegistrarService,
  ],
})
export class AssistantModule {}
