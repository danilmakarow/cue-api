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
import { ToolDispatcherService } from './tools/tool-dispatcher.service';
import { WebhookRegistrarService } from './webhook-registrar.service';
import { WebhookConsumer } from './webhook.consumer';
import { WEBHOOK_QUEUE_NAME } from '../redis/redis.constants';
import { AiModule } from '@/modules/ai/ai.module';
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
    SttModule,
    BullModule.registerQueue({ name: WEBHOOK_QUEUE_NAME }),
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
    WebhookConsumer,
    WebhookRegistrarService,
  ],
})
export class AssistantModule {}
