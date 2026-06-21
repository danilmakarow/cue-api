import { ConfigModule } from '@nestjs/config';
import { z } from 'zod';

/**
 * A Zod preprocessed schema that validates and converts incoming values into a boolean.
 */
const booleanValidator = z.preprocess((val) => {
  if (!val || typeof val !== 'string' || !['true', 'false'].includes(val)) {
    return undefined;
  }

  return val === 'true';
}, z.boolean());

/**
 * Schema definition for environment variables using Zod.
 * Validates and enforces the structure of environment variables required by the application.
 */
// Every variable below is REQUIRED — no `.optional()`, no `.default()`. A missing or malformed value
// makes validateEnvs throw at boot rather than silently falling back, so a mis-provisioned environment
// fails loudly instead of disabling a feature behind the scenes. Production supplies every key via SSM
// (infra/production/ssm.tf for non-secrets, seed-secrets.sh for secrets); local dev supplies them via
// .env (see .env.example). To add a new var: add it here AND to both of those, or the app won't start.
export const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']),
    PORT: z.coerce.number(),

    // Database configuration
    DB_HOST: z.string(),
    DB_PORT: z.coerce.number(),
    DB_USERNAME: z.string(),
    DB_PASSWORD: z.string(),
    DB_DATABASE: z.string(),
    DB_SYNCHRONIZE: booleanValidator,
    DB_RUN_MIGRATIONS: booleanValidator,
    DB_LOGGING: booleanValidator,
    DB_DISABLE_SSL_AUTH: booleanValidator,

    // Auth configuration
    JWT_SECRET: z.string().min(32),
    JWT_EXPIRES_IN: z.string(),
    APPLE_CLIENT_ID: z.string(),

    // Redis configuration (first consumed by the assistant: BullMQ webhook queue,
    // dedupe set, link nonces, held-conflict writes).
    REDIS_HOST: z.string(),
    REDIS_PORT: z.coerce.number(),
    // Required, but an empty string is accepted for a password-less Redis (set `REDIS_PASSWORD=` locally).
    REDIS_PASSWORD: z.string(),
    REDIS_DB: z.coerce.number().int().min(0),

    // External messaging vendor (Telegram) — read by the external-vendor connector.
    EXTERNAL_VENDOR: z.enum(['telegram']),
    TELEGRAM_BOT_TOKEN: z.string(),
    TELEGRAM_WEBHOOK_SECRET: z.string(),
    TELEGRAM_API_BASE: z.string(),

    // AI provider (Anthropic) — read by the AI connector.
    ASSISTANT_AI_PROVIDER: z.enum(['anthropic']),
    ANTHROPIC_API_KEY: z.string(),
    ASSISTANT_MODEL_MAIN: z.string(),
    ASSISTANT_MODEL_BACKGROUND: z.string(),
    ASSISTANT_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive(),
    ASSISTANT_AI_MAX_RETRIES: z.coerce.number().int().min(0),

    // Speech-to-text (OpenAI) — read by the STT connector.
    STT_PROVIDER: z.enum(['openai']),
    OPENAI_API_KEY: z.string(),
    STT_MODEL: z.string(),
    STT_TRANSLATE_TO_ENGLISH: booleanValidator,

    // Assistant orchestration knobs.
    // Public HTTPS base the app registers the Telegram webhook against on boot (it appends
    // /assistant/telegram/webhook).
    ASSISTANT_WEBHOOK_URL: z.string(),
    // Public HTTPS base for the iOS universal link in the linking prompt (must match the app's
    // Associated Domains entitlement and serve an apple-app-site-association file).
    ASSISTANT_APP_LINK_BASE_URL: z.string(),
    ASSISTANT_MAX_TOOL_ROUNDTRIPS: z.coerce.number().int().positive(),
    ASSISTANT_MAX_SCHEDULE_FETCHES: z.coerce.number().int().positive(),
    // Narration re-drive budget (ADR 0009): how many corrective re-invocations a
    // turn may make when the model narrates a write but calls no tools. Default 5;
    // 0 is the kill-switch (reverts to detect-and-mask). Must stay strictly below
    // ASSISTANT_MAX_TOOL_ROUNDTRIPS so the round-trip ceiling is the outer bound.
    ASSISTANT_MAX_CORRECTIONS: z.coerce.number().int().min(0),
    ASSISTANT_HELD_CONFLICT_TTL_SECONDS: z.coerce.number().int().positive(),
    // ask_user suspend/resume (ADR 0010). The hot Redis index TTL (the free-text
    // answer window); after it lapses a typed message starts a fresh turn while a
    // button still resumes from Postgres up to the retention horizon below.
    ASSISTANT_ASK_USER_TTL_SECONDS: z.coerce.number().int().positive(),
    // Hard durable retention (hours) for a suspended ask_user row: a button answer
    // resumes from Postgres anytime within this horizon (even after the Redis TTL
    // and a process restart); the cleanup job expires rows past it.
    ASSISTANT_ASK_USER_RETENTION_HOURS: z.coerce.number().int().positive(),
    // Live-status handle (StatusSession, ADR 0012) TTL (seconds): the per-chat/turn
    // Redis pointer to the animated status surface (draft id / message id). Short —
    // it only needs to outlive one in-flight turn; cleared on finalize.
    ASSISTANT_STATUS_SESSION_TTL_SECONDS: z.coerce.number().int().positive(),
    // Per-user serialization lock (StatusSession ADR 0012 sibling; Story 11). The
    // mutex's auto-expiry TTL (ms) — the deadlock backstop if a holder crashes
    // without releasing — and the watchdog renew interval (ms) that extends it
    // while work is in progress. Renew MUST be strictly below the TTL so a live
    // holder always re-arms before expiry; the cross-field guard in `.superRefine`
    // below enforces this at boot.
    ASSISTANT_USER_LOCK_TTL_MS: z.coerce.number().int().positive(),
    ASSISTANT_USER_LOCK_RENEW_MS: z.coerce.number().int().positive(),
    ASSISTANT_LINK_NONCE_TTL_SECONDS: z.coerce.number().int().positive(),
    ASSISTANT_DEDUPE_TTL_SECONDS: z.coerce.number().int().positive(),
    ASSISTANT_RECENT_WINDOW_SIZE: z.coerce.number().int().positive(),
    ASSISTANT_PRELOAD_HORIZON_DAYS: z.coerce.number().int().positive(),
    ASSISTANT_SUMMARIZE_THRESHOLD: z.coerce.number().int().positive(),
  })
  .superRefine((env, ctx) => {
    // The lock watchdog must re-arm the TTL before it lapses; if the renew
    // interval is not strictly below the TTL the first renewal would only fire
    // after the lock already expired, dropping the per-user lock mid-turn.
    if (env.ASSISTANT_USER_LOCK_RENEW_MS >= env.ASSISTANT_USER_LOCK_TTL_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ASSISTANT_USER_LOCK_RENEW_MS'],
        message:
          'ASSISTANT_USER_LOCK_RENEW_MS renew interval must be strictly less than the lock TTL ASSISTANT_USER_LOCK_TTL_MS',
      });
    }
  });

export type EnvironmentVariables = z.infer<typeof environmentSchema>;

/**
 * Validates the provided configuration object against the environment schema.
 * If validation fails, an error is thrown detailing the issues.
 */
export const validateEnvs = (config: Record<string, unknown>) => {
  const result = environmentSchema.safeParse(config);

  if (!result.success) {
    throw new Error(
      `Environment validation failed: ${result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join(', ')}`,
    );
  }

  return result.data;
};

/**
 * Factory that returns a configured ConfigModule for the NestJS app.
 * Registers environment files and wires the Zod validator.
 */
export const getConfigModule = () =>
  ConfigModule.forRoot({
    isGlobal: true,
    validate: validateEnvs,
    envFilePath: ['.env.local', '.env'],
  });
