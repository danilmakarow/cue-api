import { validateEnvs } from './env.config';

/**
 * A complete, valid environment used as the baseline for the cross-field
 * validation tests. Mirrors `.env.example`; individual cases override only the
 * lock TTL / renew pair under test.
 */
const validEnv: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '3000',

  DB_HOST: 'localhost',
  DB_PORT: '5432',
  DB_USERNAME: 'cue',
  DB_PASSWORD: 'cue',
  DB_DATABASE: 'cue',
  DB_SYNCHRONIZE: 'false',
  DB_RUN_MIGRATIONS: 'true',
  DB_LOGGING: 'true',
  DB_DISABLE_SSL_AUTH: 'false',

  JWT_SECRET: 'change-me-to-a-long-random-secret-at-least-32-chars',
  JWT_EXPIRES_IN: '30d',
  APPLE_CLIENT_ID: 'makarov.cue',

  REDIS_HOST: 'localhost',
  REDIS_PORT: '6379',
  REDIS_PASSWORD: '',
  REDIS_DB: '0',

  EXTERNAL_VENDOR: 'telegram',
  TELEGRAM_BOT_TOKEN: 'token',
  TELEGRAM_WEBHOOK_SECRET: 'secret',
  TELEGRAM_API_BASE: 'https://api.telegram.org',

  ASSISTANT_AI_PROVIDER: 'anthropic',
  ANTHROPIC_API_KEY: 'key',
  ASSISTANT_MODEL_MAIN: 'claude-sonnet-4-5',
  ASSISTANT_MODEL_BACKGROUND: 'claude-haiku-4-5',
  ASSISTANT_MAX_OUTPUT_TOKENS: '1024',
  ASSISTANT_AI_MAX_RETRIES: '2',

  STT_PROVIDER: 'openai',
  OPENAI_API_KEY: 'key',
  STT_MODEL: 'gpt-4o-mini-transcribe',
  STT_TRANSLATE_TO_ENGLISH: 'false',

  ASSISTANT_WEBHOOK_URL: 'https://cue.ngrok.app',
  ASSISTANT_APP_LINK_BASE_URL: 'https://cue.ngrok.app',
  ASSISTANT_MAX_TOOL_ROUNDTRIPS: '8',
  ASSISTANT_MAX_SCHEDULE_FETCHES: '5',
  ASSISTANT_MAX_CORRECTIONS: '5',
  ASSISTANT_ASK_USER_TTL_SECONDS: '1800',
  ASSISTANT_ASK_USER_RETENTION_HOURS: '168',
  ASSISTANT_STATUS_SESSION_TTL_SECONDS: '120',
  ASSISTANT_STATUS_DOT_INTERVAL_MS: '500',
  ASSISTANT_STATUS_WORD_INTERVAL_MS: '5000',
  ASSISTANT_USER_LOCK_TTL_MS: '30000',
  ASSISTANT_USER_LOCK_RENEW_MS: '10000',
  ASSISTANT_DEBOUNCE_WINDOW_MS: '2000',
  ASSISTANT_DEBOUNCE_QUEUE_AFTER_MS: '750',
  ASSISTANT_STOP_FLAG_TTL_SECONDS: '300',
  ASSISTANT_LAST_BUTTON_TTL_SECONDS: '300',
  ASSISTANT_LINK_NONCE_TTL_SECONDS: '600',
  ASSISTANT_DEDUPE_TTL_SECONDS: '3600',
  ASSISTANT_RECENT_WINDOW_SIZE: '10',
  ASSISTANT_PRELOAD_HORIZON_DAYS: '7',
  ASSISTANT_SUMMARIZE_THRESHOLD: '20',
};

describe('validateEnvs', () => {
  it('accepts a renew interval strictly below the lock TTL', () => {
    const parsed = validateEnvs({
      ...validEnv,
      ASSISTANT_USER_LOCK_TTL_MS: '30000',
      ASSISTANT_USER_LOCK_RENEW_MS: '10000',
    });

    expect(parsed.ASSISTANT_USER_LOCK_RENEW_MS).toBe(10000);
    expect(parsed.ASSISTANT_USER_LOCK_TTL_MS).toBe(30000);
  });

  it('rejects a renew interval equal to the lock TTL', () => {
    expect(() =>
      validateEnvs({
        ...validEnv,
        ASSISTANT_USER_LOCK_TTL_MS: '30000',
        ASSISTANT_USER_LOCK_RENEW_MS: '30000',
      }),
    ).toThrow(/strictly less than the lock TTL/);
  });

  it('rejects a renew interval greater than the lock TTL', () => {
    expect(() =>
      validateEnvs({
        ...validEnv,
        ASSISTANT_USER_LOCK_TTL_MS: '30000',
        ASSISTANT_USER_LOCK_RENEW_MS: '45000',
      }),
    ).toThrow(/ASSISTANT_USER_LOCK_RENEW_MS/);
  });
});
