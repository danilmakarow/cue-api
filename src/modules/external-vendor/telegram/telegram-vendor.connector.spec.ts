import {
  ExternalVendorConfig,
  TelegramVendorConfig,
} from '../external-vendor.config';
import {
  ChatAction,
  ChatType,
  ExternalVendor,
  InboundKind,
  OutboundFormat,
  WebhookJob,
} from '../external-vendor.types';
import { TelegramVendorConnector } from './telegram-vendor.connector';

const TELEGRAM_CONFIG: TelegramVendorConfig = {
  botToken: 'TEST_TOKEN',
  webhookSecret: 'super-secret',
  apiBase: 'https://api.telegram.test',
};

/**
 * Builds a connector wired to a stub config so tests never touch ConfigService.
 */
const createConnector = (): TelegramVendorConnector => {
  const configStub = {
    getTelegramConfig: () => TELEGRAM_CONFIG,
  } as unknown as ExternalVendorConfig;

  return new TelegramVendorConnector(configStub);
};

/**
 * Builds a `WebhookJob` from a Telegram update object by serializing it to the
 * raw body the consumer would receive.
 */
const jobFromUpdate = (update: Record<string, unknown>): WebhookJob => ({
  rawBody: Buffer.from(JSON.stringify(update), 'utf8'),
  receivedAt: '2026-06-01T00:00:00.000Z',
});

/**
 * Installs a typed mock for `global.fetch` and returns the jest mock for
 * assertions. Each test sets the resolved value(s) it needs.
 */
const mockFetch = (): jest.Mock => {
  const fetchMock = jest.fn();

  global.fetch = fetchMock as unknown as typeof fetch;

  return fetchMock;
};

/**
 * Builds a minimal `ok: true` Telegram JSON response for `callApi`.
 */
const okResponse = (result: unknown = {}): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result }),
  }) as unknown as Response;

describe('TelegramVendorConnector', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  describe('identity', () => {
    it('reports the Telegram vendor and capability flags', () => {
      const connector = createConnector();

      expect(connector.vendor).toBe(ExternalVendor.Telegram);
      expect(connector.capabilities).toEqual({
        supportsVoice: true,
        supportsInlineButtons: true,
        supportsCallbacks: true,
      });
    });
  });

  describe('acceptWebhook', () => {
    it('accepts when the secret header matches', () => {
      const connector = createConnector();
      const fetchMock = mockFetch();

      const accepted = connector.acceptWebhook({
        headers: { 'x-telegram-bot-api-secret-token': 'super-secret' },
        rawBody: Buffer.from('{"update_id":1}', 'utf8'),
      });

      expect(accepted).toBe(true);
      // Auth only: nothing parsed, no IO.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('matches the header case-insensitively', () => {
      const connector = createConnector();

      const accepted = connector.acceptWebhook({
        headers: { 'X-Telegram-Bot-Api-Secret-Token': 'super-secret' },
        rawBody: Buffer.alloc(0),
      });

      expect(accepted).toBe(true);
    });

    it('rejects on a mismatched secret without parsing the body', () => {
      const connector = createConnector();
      const fetchMock = mockFetch();
      const rawBody = Buffer.from('not-json-should-not-be-parsed', 'utf8');
      const parseSpy = jest.spyOn(JSON, 'parse');

      const accepted = connector.acceptWebhook({
        headers: { 'x-telegram-bot-api-secret-token': 'wrong' },
        rawBody,
      });

      expect(accepted).toBe(false);
      expect(parseSpy).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects when the secret header is missing', () => {
      const connector = createConnector();

      const accepted = connector.acceptWebhook({
        headers: {},
        rawBody: Buffer.alloc(0),
      });

      expect(accepted).toBe(false);
    });
  });

  describe('handleWebhook', () => {
    it('normalizes a plain text message', async () => {
      const connector = createConnector();
      const result = await connector.handleWebhook(
        jobFromUpdate({
          update_id: 42,
          message: {
            message_id: 7,
            chat: { id: 12345, type: 'private' },
            from: { id: 999 },
            text: 'move my 3pm to tomorrow',
          },
        }),
      );

      expect(result).toEqual({
        kind: InboundKind.Text,
        vendorChatId: '12345',
        vendorUserId: '999',
        dedupeId: '42',
        text: 'move my 3pm to tomorrow',
        chatType: ChatType.Private,
      });
    });

    it('normalizes a slash command, stripping the slash and splitting args', async () => {
      const connector = createConnector();
      const result = await connector.handleWebhook(
        jobFromUpdate({
          update_id: 43,
          message: {
            message_id: 8,
            chat: { id: 12345 },
            from: { id: 999 },
            text: '/remind buy milk later',
          },
        }),
      );

      expect(result).toEqual({
        kind: InboundKind.Command,
        vendorChatId: '12345',
        vendorUserId: '999',
        dedupeId: '43',
        command: 'remind',
        commandArgs: ['buy', 'milk', 'later'],
      });
    });

    it('normalizes a voice message into a MediaRef without downloading', async () => {
      const connector = createConnector();
      const fetchMock = mockFetch();

      const result = await connector.handleWebhook(
        jobFromUpdate({
          update_id: 44,
          message: {
            message_id: 9,
            chat: { id: 12345 },
            from: { id: 999 },
            voice: { file_id: 'voice-file-1', mime_type: 'audio/ogg' },
          },
        }),
      );

      expect(result).toEqual({
        kind: InboundKind.Voice,
        vendorChatId: '12345',
        vendorUserId: '999',
        dedupeId: '44',
        media: { vendorFileId: 'voice-file-1', mimeHint: 'audio/ogg' },
      });
      // handleWebhook must not download media.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('normalizes a callback query carrying data and id', async () => {
      const connector = createConnector();
      const result = await connector.handleWebhook(
        jobFromUpdate({
          update_id: 45,
          callback_query: {
            id: 'cb-1',
            from: { id: 999 },
            data: 'resolve:keep',
            message: { message_id: 10, chat: { id: 12345 } },
          },
        }),
      );

      expect(result).toEqual({
        kind: InboundKind.Callback,
        vendorChatId: '12345',
        vendorUserId: '999',
        dedupeId: '45',
        callbackData: 'resolve:keep',
        callbackId: 'cb-1',
      });
    });

    it('returns null for an update with nothing we handle', async () => {
      const connector = createConnector();
      const result = await connector.handleWebhook(
        jobFromUpdate({ update_id: 46, edited_message: { message_id: 1 } }),
      );

      expect(result).toBeNull();
    });

    it('returns null for a message with neither text nor voice', async () => {
      const connector = createConnector();
      const result = await connector.handleWebhook(
        jobFromUpdate({
          update_id: 47,
          message: { message_id: 11, chat: { id: 1 }, from: { id: 2 } },
        }),
      );

      expect(result).toBeNull();
    });
  });

  describe('fetchMedia', () => {
    it('resolves the file path then downloads bytes from the file endpoint', async () => {
      const connector = createConnector();
      const fetchMock = mockFetch();
      const audioBytes = Buffer.from([1, 2, 3, 4]);

      fetchMock
        .mockResolvedValueOnce(okResponse({ file_path: 'voice/file_1.ogg' }))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { get: () => 'audio/ogg' },
          arrayBuffer: async () =>
            audioBytes.buffer.slice(
              audioBytes.byteOffset,
              audioBytes.byteOffset + audioBytes.byteLength,
            ),
        } as unknown as Response);

      const media = await connector.fetchMedia({
        vendorFileId: 'voice-file-1',
        mimeHint: 'audio/ogg',
      });

      const firstCallUrl = fetchMock.mock.calls[0][0] as string;
      const secondCallUrl = fetchMock.mock.calls[1][0] as string;

      expect(firstCallUrl).toBe(
        'https://api.telegram.test/botTEST_TOKEN/getFile',
      );
      expect(secondCallUrl).toBe(
        'https://api.telegram.test/file/botTEST_TOKEN/voice/file_1.ogg',
      );
      expect(media.mimeType).toBe('audio/ogg');
      expect(Buffer.isBuffer(media.bytes)).toBe(true);
      expect(media.bytes.equals(audioBytes)).toBe(true);
    });

    it('throws when getFile returns no file_path', async () => {
      const connector = createConnector();
      const fetchMock = mockFetch();

      fetchMock.mockResolvedValueOnce(okResponse({}));

      await expect(
        connector.fetchMedia({ vendorFileId: 'missing' }),
      ).rejects.toThrow(/file_path/);
    });
  });

  describe('outbound', () => {
    it('sendMessage posts chat_id and text (plain → no parse_mode) and returns the message ref', async () => {
      const connector = createConnector();
      const fetchMock = mockFetch();

      fetchMock.mockResolvedValue(okResponse({ message_id: 555 }));

      const ref = await connector.sendMessage(
        { vendorChatId: '12345' },
        { text: 'done' },
      );

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

      expect(url).toBe('https://api.telegram.test/botTEST_TOKEN/sendMessage');
      expect(init.method).toBe('POST');

      const body = JSON.parse(init.body as string);

      expect(body).toEqual({
        chat_id: '12345',
        text: 'done',
        parse_mode: undefined,
      });
      // message_id is stringified per the bigint-as-string convention.
      expect(ref).toEqual({ vendorMessageId: '555' });
    });

    it('sendMessage maps Markdown format to a parse_mode', async () => {
      const connector = createConnector();
      const fetchMock = mockFetch();

      fetchMock.mockResolvedValue(okResponse({ message_id: 1 }));

      await connector.sendMessage(
        { vendorChatId: '12345' },
        { text: '*bold*', format: OutboundFormat.Markdown },
      );

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(init.body as string);

      expect(body.parse_mode).toBe('MarkdownV2');
    });

    it('sendActions posts an inline_keyboard reply_markup and returns the message ref', async () => {
      const connector = createConnector();
      const fetchMock = mockFetch();

      fetchMock.mockResolvedValue(okResponse({ message_id: 777 }));

      const ref = await connector.sendActions(
        { vendorChatId: '12345' },
        {
          text: 'Conflict — keep or move?',
          buttons: [
            [
              { label: 'Keep', callbackData: 'resolve:keep' },
              { label: 'Move', callbackData: 'resolve:move' },
            ],
          ],
        },
      );

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

      expect(url).toBe('https://api.telegram.test/botTEST_TOKEN/sendMessage');

      const body = JSON.parse(init.body as string);

      expect(body.chat_id).toBe('12345');
      expect(body.text).toBe('Conflict — keep or move?');
      expect(body.reply_markup).toEqual({
        inline_keyboard: [
          [
            { text: 'Keep', callback_data: 'resolve:keep' },
            { text: 'Move', callback_data: 'resolve:move' },
          ],
        ],
      });
      // Caller needs the message id to later edit this keyboard.
      expect(ref).toEqual({ vendorMessageId: '777' });
    });

    it('acknowledgeCallback posts answerCallbackQuery with the callback id and text', async () => {
      const connector = createConnector();
      const fetchMock = mockFetch();

      fetchMock.mockResolvedValue(okResponse());

      await connector.acknowledgeCallback('cb-1', { text: 'Got it' });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

      expect(url).toBe(
        'https://api.telegram.test/botTEST_TOKEN/answerCallbackQuery',
      );

      const body = JSON.parse(init.body as string);

      expect(body).toEqual({ callback_query_id: 'cb-1', text: 'Got it' });
    });

    it('registerWebhook posts setWebhook with url, secret_token and allowed_updates', async () => {
      const connector = createConnector();
      const fetchMock = mockFetch();

      fetchMock.mockResolvedValue(okResponse());

      await connector.registerWebhook('https://cue.example/webhook');

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

      expect(url).toBe('https://api.telegram.test/botTEST_TOKEN/setWebhook');

      const body = JSON.parse(init.body as string);

      expect(body.url).toBe('https://cue.example/webhook');
      expect(body.secret_token).toBe('super-secret');
      expect(body.allowed_updates).toEqual(['message', 'callback_query']);
    });

    it('removeWebhook posts deleteWebhook', async () => {
      const connector = createConnector();
      const fetchMock = mockFetch();

      fetchMock.mockResolvedValue(okResponse());

      await connector.removeWebhook();

      const url = fetchMock.mock.calls[0][0] as string;

      expect(url).toBe('https://api.telegram.test/botTEST_TOKEN/deleteWebhook');
    });

    it('throws when Telegram responds ok:false', async () => {
      const connector = createConnector();
      const fetchMock = mockFetch();

      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: false, description: 'chat not found' }),
      } as unknown as Response);

      await expect(
        connector.sendMessage({ vendorChatId: 'bad' }, { text: 'hi' }),
      ).rejects.toThrow(/chat not found/);
    });
  });

  describe('messenger primitives (Story 10, ADR 0012)', () => {
    it('normalizes chat.type onto a callback query (group → ChatType.Group)', async () => {
      const connector = createConnector();

      const result = await connector.handleWebhook(
        jobFromUpdate({
          update_id: 70,
          callback_query: {
            id: 'cb-2',
            from: { id: 999 },
            data: 'ask:row:opt',
            message: { message_id: 10, chat: { id: 12345, type: 'group' } },
          },
        }),
      );

      expect(result?.chatType).toBe(ChatType.Group);
    });

    it('leaves chatType undefined when chat.type is absent/unknown', async () => {
      const connector = createConnector();

      const result = await connector.handleWebhook(
        jobFromUpdate({
          update_id: 71,
          message: {
            message_id: 7,
            chat: { id: 12345 },
            from: { id: 999 },
            text: 'hi',
          },
        }),
      );

      expect(result?.chatType).toBeUndefined();
    });

    it('sendMessageWithKeyboard docks a persistent reply keyboard (is_persistent + resize_keyboard)', async () => {
      const connector = createConnector();
      const fetchMock = mockFetch();

      fetchMock.mockResolvedValue(okResponse({ message_id: 111 }));

      const ref = await connector.sendMessageWithKeyboard(
        { vendorChatId: '12345' },
        {
          text: 'Pick one',
          replyKeyboard: {
            buttons: [
              [{ label: "Today's schedule" }, { label: 'Next week' }],
              [{ label: 'Settings' }],
            ],
          },
        },
      );

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(init.body as string);

      expect(body.chat_id).toBe('12345');
      expect(body.text).toBe('Pick one');
      expect(body.reply_markup).toEqual({
        keyboard: [
          [{ text: "Today's schedule" }, { text: 'Next week' }],
          [{ text: 'Settings' }],
        ],
        is_persistent: true,
        resize_keyboard: true,
      });
      expect(ref).toEqual({ vendorMessageId: '111' });
    });

    it('sendMessageWithKeyboard removes the docked keyboard via the remove sentinel', async () => {
      const connector = createConnector();
      const fetchMock = mockFetch();

      fetchMock.mockResolvedValue(okResponse({ message_id: 112 }));

      await connector.sendMessageWithKeyboard(
        { vendorChatId: '12345' },
        { text: 'done', replyKeyboard: { remove: true } },
      );

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(init.body as string);

      expect(body.reply_markup).toEqual({ remove_keyboard: true });
    });

    it('editMessageText posts editMessageText with numeric message_id', async () => {
      const connector = createConnector();
      const fetchMock = mockFetch();

      fetchMock.mockResolvedValue(okResponse({ message_id: 5 }));

      await connector.editMessageText(
        { vendorChatId: '12345' },
        { vendorMessageId: '5', text: 'updated' },
      );

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

      expect(url).toBe(
        'https://api.telegram.test/botTEST_TOKEN/editMessageText',
      );

      const body = JSON.parse(init.body as string);

      expect(body).toEqual({
        chat_id: '12345',
        message_id: 5,
        text: 'updated',
        parse_mode: undefined,
      });
    });

    it('sendChatAction posts sendChatAction with the mapped action string', async () => {
      const connector = createConnector();
      const fetchMock = mockFetch();

      fetchMock.mockResolvedValue(okResponse());

      await connector.sendChatAction(
        { vendorChatId: '12345' },
        ChatAction.Typing,
      );

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

      expect(url).toBe(
        'https://api.telegram.test/botTEST_TOKEN/sendChatAction',
      );

      const body = JSON.parse(init.body as string);

      expect(body).toEqual({ chat_id: '12345', action: 'typing' });
    });

    it('deleteMessage posts deleteMessage with numeric message_id', async () => {
      const connector = createConnector();
      const fetchMock = mockFetch();

      fetchMock.mockResolvedValue(okResponse(true));

      await connector.deleteMessage({ vendorChatId: '12345' }, '5');

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

      expect(url).toBe('https://api.telegram.test/botTEST_TOKEN/deleteMessage');

      const body = JSON.parse(init.body as string);

      expect(body).toEqual({ chat_id: '12345', message_id: 5 });
    });

    it('sendMessageDraft posts sendMessageDraft with draft_id + text in a private chat', async () => {
      const connector = createConnector();
      const fetchMock = mockFetch();

      fetchMock.mockResolvedValue(okResponse());

      await connector.sendMessageDraft(
        { vendorChatId: '12345', chatType: ChatType.Private },
        { draftId: 7, text: '' },
      );

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

      expect(url).toBe(
        'https://api.telegram.test/botTEST_TOKEN/sendMessageDraft',
      );

      const body = JSON.parse(init.body as string);

      // Empty text ⇒ native "Thinking…" shimmer; draft_id is the animation key.
      expect(body).toEqual({
        chat_id: '12345',
        draft_id: 7,
        text: '',
        parse_mode: undefined,
      });
    });

    it('sendMessageDraft allows a private chat with no chatType set (back-compat)', async () => {
      const connector = createConnector();
      const fetchMock = mockFetch();

      fetchMock.mockResolvedValue(okResponse());

      await connector.sendMessageDraft(
        { vendorChatId: '12345' },
        { draftId: 9, text: 'partial' },
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('GATE: sendMessageDraft throws for a non-private chat and never calls the API', async () => {
      const connector = createConnector();
      const fetchMock = mockFetch();

      await expect(
        connector.sendMessageDraft(
          { vendorChatId: '12345', chatType: ChatType.Group },
          { draftId: 7, text: 'hi' },
        ),
      ).rejects.toThrow(/private-chat only/);

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
