import { StatusSessionPhase, StatusSessionStore } from './status-session.store';
import { statusSessionKey } from '../../redis/redis.constants';
import { ChatType } from '@/modules/external-vendor/external-vendor.types';

/**
 * A tiny in-memory Redis fake covering exactly the surface the store uses:
 * `set` with optional `EX <ttl>` and `NX` (returns 'OK' on a write, null when NX
 * loses), `get`, and `del`. This lets the idempotency race be asserted against
 * real `SET NX` semantics rather than a hand-stubbed return value.
 */
const buildRedisFake = () => {
  const store = new Map<string, string>();
  const setCalls: unknown[][] = [];

  const redis = {
    set: jest.fn(
      async (
        key: string,
        value: string,
        ...rest: unknown[]
      ): Promise<'OK' | null> => {
        setCalls.push([key, value, ...rest]);

        const hasNx = rest.includes('NX');

        if (hasNx && store.has(key)) {
          return null;
        }

        store.set(key, value);

        return 'OK';
      },
    ),
    get: jest.fn(
      async (key: string): Promise<string | null> => store.get(key) ?? null,
    ),
    del: jest.fn(async (key: string): Promise<number> => {
      const existed = store.has(key);

      store.delete(key);

      return existed ? 1 : 0;
    }),
  };

  return { redis, store, setCalls };
};

const buildStore = () => {
  const { redis, store, setCalls } = buildRedisFake();
  const config = { statusSessionTtlSeconds: 120 };
  const service = new StatusSessionStore(redis as never, config as never);

  return { service, redis, store, setCalls };
};

const PRIVATE_INPUT = {
  vendorChatId: 'chat-1',
  turnId: 'turn-1',
  chatType: ChatType.Private,
  locale: 'en',
  seedVendorMessageId: 'msg-42',
};

describe('StatusSessionStore (live-status handle, ADR 0053)', () => {
  it('open persists the Message-only handle under a per-chat/turn key with NX + TTL', async () => {
    const { service, redis, setCalls } = buildStore();

    const session = await service.open(PRIVATE_INPUT);

    // The status surface is always one real message edited in place (ADR 0053):
    // the handle carries the seed message id, locale, chat type, and Thinking.
    expect(session.vendorMessageId).toBe('msg-42');
    expect(session.locale).toBe('en');
    expect(session.chatType).toBe(ChatType.Private);
    expect(session.vendorChatId).toBe('chat-1');
    expect(session.turnId).toBe('turn-1');
    expect(session.phase).toBe(StatusSessionPhase.Thinking);

    const [key, , ...opts] = setCalls[0] as [string, string, ...unknown[]];

    expect(key).toBe(statusSessionKey('chat-1', 'turn-1'));
    // SET ... EX 120 NX — idempotent create with the configured TTL.
    expect(opts).toContain('EX');
    expect(opts).toContain(120);
    expect(opts).toContain('NX');
    expect(redis.set).toHaveBeenCalledTimes(1);
  });

  it('open without a seed message id leaves vendorMessageId undefined', async () => {
    const { service } = buildStore();

    const session = await service.open({
      vendorChatId: 'chat-2',
      turnId: 'turn-2',
      chatType: ChatType.Private,
      locale: 'en',
    });

    // The real message id is absent until the initial send lands.
    expect(session.vendorMessageId).toBeUndefined();
    expect(session.phase).toBe(StatusSessionPhase.Thinking);
  });

  it('IDEMPOTENCY: opening twice for the SAME turn does NOT orphan a second handle', async () => {
    const { service, store } = buildStore();

    const first = await service.open(PRIVATE_INPUT);
    // A second open for the same turn — e.g. a replayed BullMQ job — with a
    // DIFFERENT seed message id must NOT overwrite or create a new surface.
    const second = await service.open({
      ...PRIVATE_INPUT,
      seedVendorMessageId: 'msg-999',
    });

    // Exactly one handle persisted, and it is the first one (NX lost on retry).
    expect(store.size).toBe(1);
    expect(second.vendorMessageId).toBe(first.vendorMessageId);
    expect(second.vendorMessageId).toBe('msg-42');
  });

  it('IDEMPOTENCY under concurrency: two simultaneous opens yield one shared handle', async () => {
    const { service, store } = buildStore();

    const [first, second] = await Promise.all([
      service.open(PRIVATE_INPUT),
      service.open({ ...PRIVATE_INPUT, seedVendorMessageId: 'msg-777' }),
    ]);

    expect(store.size).toBe(1);
    // Both callers observe the SAME message id (whichever won the NX race),
    // never two distinct surfaces.
    expect(first.vendorMessageId).toBe(second.vendorMessageId);
  });

  it('get returns the open handle and null after clear', async () => {
    const { service } = buildStore();

    await service.open(PRIVATE_INPUT);
    expect(await service.get('chat-1', 'turn-1')).not.toBeNull();

    await service.clear('chat-1', 'turn-1');
    expect(await service.get('chat-1', 'turn-1')).toBeNull();
  });

  it('get returns null when no session was ever opened', async () => {
    const { service } = buildStore();

    expect(await service.get('chat-x', 'turn-x')).toBeNull();
  });

  it('clear deletes the per-chat/turn key', async () => {
    const { service, store } = buildStore();

    await service.open(PRIVATE_INPUT);
    expect(store.size).toBe(1);

    await service.clear('chat-1', 'turn-1');

    expect(store.size).toBe(0);
    expect(store.has(statusSessionKey('chat-1', 'turn-1'))).toBe(false);
  });

  it('advancePhase moves Thinking → Working in place and refreshes the handle', async () => {
    const { service } = buildStore();

    const opened = await service.open(PRIVATE_INPUT);

    expect(opened.phase).toBe(StatusSessionPhase.Thinking);

    const advanced = await service.advancePhase(
      'chat-1',
      'turn-1',
      StatusSessionPhase.Working,
    );

    expect(advanced?.phase).toBe(StatusSessionPhase.Working);

    // The persisted handle reflects the new phase.
    const reread = await service.get('chat-1', 'turn-1');

    expect(reread?.phase).toBe(StatusSessionPhase.Working);
  });

  it('advancePhase on a missing session is a null no-op', async () => {
    const { service } = buildStore();

    expect(
      await service.advancePhase(
        'chat-x',
        'turn-x',
        StatusSessionPhase.Working,
      ),
    ).toBeNull();
  });

  it('clear is idempotent — deleting an absent handle is a harmless no-op', async () => {
    const { service, redis } = buildStore();

    await service.clear('chat-1', 'turn-1');

    expect(redis.del).toHaveBeenCalledWith(
      statusSessionKey('chat-1', 'turn-1'),
    );
  });
});
