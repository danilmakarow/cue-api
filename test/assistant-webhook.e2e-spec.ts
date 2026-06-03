import { getQueueToken } from '@nestjs/bullmq';
import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import {
  AccessTokenGuard,
  AuthenticatedRequest,
} from '@/guards/access-token.guard';
import { AssistantWebhookController } from '@/modules/assistant/assistant-webhook.controller';
import { LinkingService } from '@/modules/assistant/linking.service';
import { ExternalVendorConnectorFactory } from '@/modules/external-vendor/external-vendor-connector.factory';
import { WellKnownController } from '@/modules/well-known/well-known.controller';

const WEBHOOK_QUEUE_NAME = 'assistant-webhook';

/**
 * Integration test for the webhook ingress: a valid update is accepted, enqueued
 * once, and answered 200 immediately; an invalid one is rejected 401 with no
 * enqueue. Also covers the JWT-guarded link status/unlink routes (guard
 * overridden, `LinkingService` mocked) and the unauthenticated AASA route. The
 * vendor connector and the BullMQ queue are mocked, so nothing touches Redis or
 * Telegram.
 */
describe('Assistant webhook (e2e)', () => {
  let app: INestApplication;
  const acceptWebhook = jest.fn();
  const queueAdd = jest.fn().mockResolvedValue({ id: 'job-1' });
  const getStatus = jest.fn();
  const unlink = jest.fn();

  const connector = { vendor: 'telegram', acceptWebhook };
  const vendorFactory = { getActive: () => connector };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AssistantWebhookController, WellKnownController],
      providers: [
        { provide: ExternalVendorConnectorFactory, useValue: vendorFactory },
        {
          provide: getQueueToken(WEBHOOK_QUEUE_NAME),
          useValue: { add: queueAdd },
        },
        {
          provide: LinkingService,
          useValue: { redeemNonce: jest.fn(), getStatus, unlink },
        },
      ],
    })
      .overrideGuard(AccessTokenGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          context.switchToHttp().getRequest<AuthenticatedRequest>().user = {
            id: 'user-1',
          } as AuthenticatedRequest['user'];

          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    acceptWebhook.mockReset();
    queueAdd.mockClear();
    getStatus.mockReset();
    unlink.mockReset();
  });

  it('returns 200 and enqueues a job when the connector accepts the update', async () => {
    acceptWebhook.mockResolvedValue(true);

    await request(app.getHttpServer())
      .post('/assistant/telegram/webhook')
      .set('x-telegram-bot-api-secret-token', 'super-secret')
      .send({ update_id: 1, message: { text: 'hi' } })
      .expect(200)
      .expect({ ok: true });

    expect(queueAdd).toHaveBeenCalledTimes(1);
  });

  it('returns 401 and enqueues nothing when the connector rejects the update', async () => {
    acceptWebhook.mockResolvedValue(false);

    await request(app.getHttpServer())
      .post('/assistant/telegram/webhook')
      .set('x-telegram-bot-api-secret-token', 'wrong')
      .send({ update_id: 2 })
      .expect(401);

    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('returns the link status from GET /assistant/link', async () => {
    getStatus.mockResolvedValue({
      linked: true,
      telegramUsername: 'tony',
      linkedAt: '2026-06-01T12:30:00.000Z',
    });

    await request(app.getHttpServer())
      .get('/assistant/link')
      .expect(200)
      .expect({
        linked: true,
        telegramUsername: 'tony',
        linkedAt: '2026-06-01T12:30:00.000Z',
      });

    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it('revokes the link via DELETE /assistant/link', async () => {
    unlink.mockResolvedValue({ linked: false });

    await request(app.getHttpServer())
      .delete('/assistant/link')
      .expect(200)
      .expect({ linked: false });

    expect(unlink).toHaveBeenCalledTimes(1);
  });

  it('serves the AASA document as application/json without auth', async () => {
    await request(app.getHttpServer())
      .get('/.well-known/apple-app-site-association')
      .expect(200)
      .expect('Content-Type', /application\/json/)
      .expect({
        applinks: {
          details: [
            {
              appIDs: ['5LKD4S53RU.makarov.cue'],
              components: [{ '/': '/app/telegram/link', '?': { code: '?*' } }],
            },
          ],
        },
      });
  });
});
