import { MediaPayload } from '@/modules/external-vendor/external-vendor.types';
import { SttConfigProvider } from '../stt.config';
import { AudioTranscoder } from './audio-transcoder';

// Jest hoists `jest.mock` above the imports, so the factory may only reference
// variables whose names start with `mock` (jest's allow-list). The spies are
// declared with that prefix and wired into the fake client below.
const mockTranscriptionsCreate = jest.fn();
const mockTranslationsCreate = jest.fn();
const mockToFile = jest.fn();
const mockOpenAiConstructor = jest.fn();

// Mock the OpenAI SDK: a fake client exposing the two audio endpoints, the
// `toFile` helper, and a real-enough `APIError` for retry-path assertions. The
// constructor records its options so we can assert `maxRetries: 0`.
jest.mock('openai', () => {
  // Mirrors the fields the connector reads off a real OpenAI `APIError`
  // (status, code, type, requestID). `code`/`type`/`requestID` are optional so
  // existing `new APIError(status, message)` call sites keep working.
  class APIError extends Error {
    status?: number;

    code?: string | null;

    type?: string;

    requestID?: string | null;

    constructor(
      status: number,
      message: string,
      code?: string | null,
      type?: string,
      requestID?: string | null,
    ) {
      super(message);
      this.status = status;
      this.code = code;
      this.type = type;
      this.requestID = requestID;
    }
  }

  class OpenAI {
    audio = {
      transcriptions: { create: mockTranscriptionsCreate },
      translations: { create: mockTranslationsCreate },
    };

    constructor(options: unknown) {
      mockOpenAiConstructor(options);
    }
  }

  return { __esModule: true, default: OpenAI, APIError, toFile: mockToFile };
});

import { Logger } from '@nestjs/common';
import * as OpenAiSdk from 'openai';

import {
  SttCapabilityNotSupportedError,
  SttPayloadTooLargeError,
  SttUnavailableError,
} from '../stt.errors';
import { SttProvider } from '../stt.types';
import { OpenAiSttConnector } from './openai-stt.connector';

// The real `APIError` constructor takes 4 args, but our mock takes `(status,
// message)` plus optional `(code, type, requestID)`. Re-type the mocked class
// through that shape so the test builds errors ergonomically while staying the
// SAME class the connector's `instanceof APIError` check sees (both resolve to
// the mocked module).
type MockApiErrorConstructor = new (
  status: number,
  message: string,
  code?: string | null,
  type?: string,
  requestID?: string | null,
) => Error;
const MockApiError = OpenAiSdk.APIError as unknown as MockApiErrorConstructor;

/** A small OGG payload (Telegram voice note shape). */
const oggPayload = (bytes = Buffer.from('ogg-bytes')): MediaPayload => ({
  bytes,
  mimeType: 'audio/ogg',
});

describe('OpenAiSttConnector', () => {
  let connector: OpenAiSttConnector;
  let transcoder: { oggToWav: jest.Mock };
  const wavBytes = Buffer.from('wav-bytes');

  beforeEach(() => {
    jest.clearAllMocks();
    mockToFile.mockResolvedValue({ name: 'audio.wav' });
    transcoder = { oggToWav: jest.fn().mockResolvedValue(wavBytes) };

    const configProvider = {
      values: { openAiApiKey: 'sk-test', model: 'gpt-4o-mini-transcribe' },
    } as unknown as SttConfigProvider;

    connector = new OpenAiSttConnector(
      configProvider,
      transcoder as unknown as AudioTranscoder,
    );
  });

  describe('capabilities', () => {
    it('declares the OpenAI capability flags', () => {
      expect(connector.provider).toBe(SttProvider.OPENAI);
      expect(connector.capabilities.translation).toBe(true);
      expect(connector.capabilities.autoDetectLanguage).toBe(true);
      expect(connector.capabilities.maxBytes).toBe(25 * 1024 * 1024);
      expect(connector.capabilities.formats).not.toContain('ogg');
      expect(connector.capabilities.formats).toContain('wav');
    });
  });

  describe('construction', () => {
    it('builds the OpenAI client with maxRetries: 0 so it does not double-retry under withRetry', () => {
      expect(mockOpenAiConstructor).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: 'sk-test', maxRetries: 0 }),
      );
    });
  });

  describe('transcribe (source language)', () => {
    it('transcodes OGG to WAV, then calls OpenAI with the converted file', async () => {
      mockTranscriptionsCreate.mockResolvedValue({ text: 'привет' });

      const result = await connector.transcribe(oggPayload());

      expect(transcoder.oggToWav).toHaveBeenCalledWith(
        Buffer.from('ogg-bytes'),
      );
      expect(mockToFile).toHaveBeenCalledWith(wavBytes, 'audio.wav', {
        type: 'audio/wav',
      });
      expect(mockTranscriptionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          file: { name: 'audio.wav' },
          model: 'gpt-4o-mini-transcribe',
          response_format: 'json',
        }),
      );
      expect(mockTranslationsCreate).not.toHaveBeenCalled();
      expect(result.text).toBe('привет');
    });

    it('passes the language hint and prompt through to the SDK', async () => {
      mockTranscriptionsCreate.mockResolvedValue({ text: 'hello' });

      await connector.transcribe(oggPayload(), {
        languageHint: 'en',
        prompt: 'Cue calendar',
      });

      expect(mockTranscriptionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ language: 'en', prompt: 'Cue calendar' }),
      );
    });

    it('does NOT transcode audio already in a supported format', async () => {
      mockTranscriptionsCreate.mockResolvedValue({ text: 'hi' });

      await connector.transcribe({ bytes: wavBytes, mimeType: 'audio/wav' });

      expect(transcoder.oggToWav).not.toHaveBeenCalled();
      expect(mockToFile).toHaveBeenCalledWith(wavBytes, 'audio.wav', {
        type: 'audio/wav',
      });
    });

    it('maps token usage onto the normalized result', async () => {
      mockTranscriptionsCreate.mockResolvedValue({
        text: 'hi',
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      });

      const result = await connector.transcribe(oggPayload());

      expect(result.usage).toEqual({
        inputTokens: 5,
        outputTokens: 2,
        totalTokens: 7,
      });
    });
  });

  describe('translate-to-English path', () => {
    it('routes to the whisper-1 translations endpoint with verbose_json', async () => {
      mockTranslationsCreate.mockResolvedValue({
        text: 'hello',
        language: 'russian',
        duration: 1.5,
      });

      const result = await connector.transcribe(oggPayload(), {
        translateToEnglish: true,
      });

      expect(mockTranslationsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'whisper-1',
          response_format: 'verbose_json',
        }),
      );
      expect(mockTranscriptionsCreate).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        text: 'hello',
        language: 'russian',
        durationSeconds: 1.5,
      });
    });
  });

  describe('size guard', () => {
    it('throws SttPayloadTooLargeError without transcoding or calling OpenAI', async () => {
      const huge = Buffer.alloc(25 * 1024 * 1024 + 1);

      await expect(
        connector.transcribe({ bytes: huge, mimeType: 'audio/ogg' }),
      ).rejects.toBeInstanceOf(SttPayloadTooLargeError);

      expect(transcoder.oggToWav).not.toHaveBeenCalled();
      expect(mockTranscriptionsCreate).not.toHaveBeenCalled();
      expect(mockToFile).not.toHaveBeenCalled();
    });
  });

  describe('retry / availability', () => {
    it('retries on a 429 then succeeds', async () => {
      mockTranscriptionsCreate
        .mockRejectedValueOnce(new MockApiError(429, 'rate limited'))
        .mockResolvedValueOnce({ text: 'recovered' });

      const result = await connector.transcribe(oggPayload());

      expect(mockTranscriptionsCreate).toHaveBeenCalledTimes(2);
      expect(result.text).toBe('recovered');
    });

    it('surfaces SttUnavailableError after exhausting retries on 5xx', async () => {
      mockTranscriptionsCreate.mockRejectedValue(
        new MockApiError(503, 'unavailable'),
      );

      await expect(connector.transcribe(oggPayload())).rejects.toBeInstanceOf(
        SttUnavailableError,
      );
      expect(mockTranscriptionsCreate).toHaveBeenCalledTimes(3);
    });

    it('does NOT retry a 4xx client error (still maps to SttUnavailableError)', async () => {
      mockTranscriptionsCreate.mockRejectedValue(
        new MockApiError(400, 'bad request'),
      );

      await expect(connector.transcribe(oggPayload())).rejects.toBeInstanceOf(
        SttUnavailableError,
      );
      expect(mockTranscriptionsCreate).toHaveBeenCalledTimes(1);
    });
  });

  describe('failure logging', () => {
    it('logs a per-attempt warn and a final error (status + operation) when a 500 exhausts retries', async () => {
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      mockTranscriptionsCreate.mockRejectedValue(
        new MockApiError(
          500,
          'server error',
          'server_error',
          'api_error',
          'req_500',
        ),
      );

      await expect(connector.transcribe(oggPayload())).rejects.toBeInstanceOf(
        SttUnavailableError,
      );
      expect(mockTranscriptionsCreate).toHaveBeenCalledTimes(3);

      // Retryable: warns on attempts 1 and 2 (attempt 3 breaks before warning).
      const retryWarns = warnSpy.mock.calls
        .map((call) => call[0] as string)
        .filter((line) => line.includes('OpenAI audio call failed'));

      expect(retryWarns).toHaveLength(2);
      expect(retryWarns[0]).toContain('operation=transcribe');
      expect(retryWarns[0]).toContain('status=500');
      expect(retryWarns[0]).toContain('attempt=1/3');

      // One terminal error log with the full provider detail.
      expect(errorSpy).toHaveBeenCalledTimes(1);

      const logged = errorSpy.mock.calls[0][0] as string;

      expect(logged).toContain('OpenAI audio call gave up');
      expect(logged).toContain('operation=transcribe');
      expect(logged).toContain('status=500');
      expect(logged).toContain('code=server_error');
      expect(logged).toContain('errorType=api_error');
      expect(logged).toContain('requestId=req_500');
      expect(logged).toContain('attempts=3');

      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('logs a single error (no retry warn) on a non-retryable 400', async () => {
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      mockTranscriptionsCreate.mockRejectedValue(
        new MockApiError(
          400,
          'bad request',
          'invalid_request',
          'invalid_request_error',
        ),
      );

      await expect(connector.transcribe(oggPayload())).rejects.toBeInstanceOf(
        SttUnavailableError,
      );
      expect(mockTranscriptionsCreate).toHaveBeenCalledTimes(1);

      // Non-retryable: no per-attempt retry warn.
      const retryWarns = warnSpy.mock.calls
        .map((call) => call[0] as string)
        .filter((line) => line.includes('OpenAI audio call failed'));

      expect(retryWarns).toHaveLength(0);

      // Exactly one terminal error log, carrying status + operation.
      expect(errorSpy).toHaveBeenCalledTimes(1);

      const logged = errorSpy.mock.calls[0][0] as string;

      expect(logged).toContain('operation=transcribe');
      expect(logged).toContain('status=400');
      expect(logged).toContain('code=invalid_request');
      expect(logged).toContain('attempts=1');

      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('names the translate operation in the failure log for the whisper-1 path', async () => {
      const errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      mockTranslationsCreate.mockRejectedValue(
        new MockApiError(400, 'bad request'),
      );

      await expect(
        connector.transcribe(oggPayload(), { translateToEnglish: true }),
      ).rejects.toBeInstanceOf(SttUnavailableError);

      const logged = errorSpy.mock.calls[0][0] as string;

      expect(logged).toContain('operation=translate');
      expect(logged).toContain('model=whisper-1');

      errorSpy.mockRestore();
    });

    it('warns with rejected size vs limit before throwing on oversized audio', async () => {
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const oversized = 25 * 1024 * 1024 + 1;

      await expect(
        connector.transcribe({
          bytes: Buffer.alloc(oversized),
          mimeType: 'audio/ogg',
        }),
      ).rejects.toBeInstanceOf(SttPayloadTooLargeError);

      const sizeWarn = warnSpy.mock.calls
        .map((call) => call[0] as string)
        .find((line) => line.includes('Audio payload rejected'));

      expect(sizeWarn).toBeDefined();
      expect(sizeWarn).toContain(`sizeBytes=${oversized}`);
      expect(sizeWarn).toContain(`maxBytes=${25 * 1024 * 1024}`);

      warnSpy.mockRestore();
    });
  });

  describe('capability gating', () => {
    it('rejects translation when the capability is disabled', async () => {
      Object.defineProperty(connector, 'capabilities', {
        value: { ...connector.capabilities, translation: false },
      });

      await expect(
        connector.transcribe(oggPayload(), { translateToEnglish: true }),
      ).rejects.toBeInstanceOf(SttCapabilityNotSupportedError);
    });
  });
});
