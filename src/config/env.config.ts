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
    // Status-surface spinner tick interval (ms, R1 / ADR 0057): how often the
    // ASCII braille spinner frame advances on the one live status message. Kept
    // around ~1000 (never sub-second) to stay clear of Telegram editMessageText
    // flood-control (429); a benign "message is not modified" 400 from an identical
    // frame is treated as success by the connector.
    ASSISTANT_STATUS_SPINNER_INTERVAL_MS: z.coerce.number().int().positive(),
    // Per-user serialization lock (StatusSession ADR 0012 sibling; Story 11). The
    // mutex's auto-expiry TTL (ms) — the deadlock backstop if a holder crashes
    // without releasing — and the watchdog renew interval (ms) that extends it
    // while work is in progress. Renew MUST be strictly below the TTL so a live
    // holder always re-arms before expiry; the cross-field guard in `.superRefine`
    // below enforces this at boot.
    ASSISTANT_USER_LOCK_TTL_MS: z.coerce.number().int().positive(),
    ASSISTANT_USER_LOCK_RENEW_MS: z.coerce.number().int().positive(),
    // Inbound debounce window (Story 14a, ADR 0042). The per-user buffer window
    // (ms, ~2000) a freshly accepted simple message waits before its turn runs;
    // each new inbound RE-ARMS it (the delayed drain job slides later) and appends
    // to the buffer, so a single thought split across bubbles becomes ONE turn by
    // concatenation in arrival order. QUEUE_AFTER_MS is the short re-arm delay used
    // when the drain finds the per-user lock already held (a turn in flight): the
    // drained batch is re-buffered and re-scheduled this far out so it runs AFTER
    // the in-flight turn instead of racing or dropping it. Both must be positive;
    // QUEUE_AFTER_MS should stay well under the user-lock TTL so a queued-after
    // batch re-polls promptly once the lock frees.
    ASSISTANT_DEBOUNCE_WINDOW_MS: z.coerce.number().int().positive(),
    ASSISTANT_DEBOUNCE_QUEUE_AFTER_MS: z.coerce.number().int().positive(),
    // Latest reply-keyboard button result (Story 16, ADR 0045) TTL (seconds): how
    // long the last deterministic button outcome line waits in Redis to be injected
    // into the NEXT model turn's volatile tail (never the cached prefix — ADR 0004).
    // It is read-then-cleared on the next turn, so this is only a self-cleaning
    // backstop for a user who taps a button and then never sends a follow-up
    // message; keep it short (a few minutes).
    ASSISTANT_LAST_BUTTON_TTL_SECONDS: z.coerce.number().int().positive(),
    // Last-message-language tracker (R2, ADR 0055) TTL (seconds): how long the
    // per-user last resolved loading-status locale (en/uk/ru) stays in Redis to be
    // borrowed by the NEXT turn's voice pre-STT "Listening…" line (which has no
    // transcript to detect yet). It is STICKY (overwritten on each known-language
    // turn, never read-cleared), so this is a self-cleaning backstop for a user who
    // goes quiet — keep it long (~7 days).
    ASSISTANT_LAST_MESSAGE_LANGUAGE_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive(),
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
