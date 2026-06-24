# Non-secret runtime config only. Secrets (DB_PASSWORD, JWT_SECRET, *_API_KEY,
# TELEGRAM_*, REDIS_PASSWORD) are NOT managed here — they're seeded out-of-band by
# seed-secrets.sh so they never enter git or Terraform state. The instance role can read
# both these and the secrets (path-scoped grant in iam.tf); deploy.sh reads the whole path.
locals {
  # Every value here is a NON-SECRET env the app's Zod schema (src/config/env.config.ts) now requires.
  # The schema has no defaults, so each required key is provided here (or, if secret, in seed-secrets.sh)
  # — a missing one fails the app at boot rather than silently falling back. Keep this in lockstep with
  # the schema: add a var there → add it here (non-secret) or to seed-secrets.sh (secret).
  app_config = {
    NODE_ENV = "production"
    PORT     = "3000"

    DB_HOST           = data.aws_db_instance.cue.address
    DB_PORT           = "5432"
    DB_USERNAME       = "cue_app"
    DB_DATABASE       = "cue"
    DB_SYNCHRONIZE    = "false"
    DB_RUN_MIGRATIONS = "true"
    DB_LOGGING        = "false"
    # RDS requires TLS. The app (typeorm.config.ts) enables SSL with rejectUnauthorized:false
    # only when this is "true" — so it MUST be "true" for RDS, or the connection is rejected
    # with "no pg_hba.conf entry ... no encryption".
    DB_DISABLE_SSL_AUTH = "true"

    # Tolerate redis_host supplied as "host:port" (Redis Cloud copy-paste): split host/port apart
    # so REDIS_HOST never carries the port (which would break DNS resolution).
    REDIS_HOST = split(":", var.redis_host)[0]
    REDIS_PORT = length(split(":", var.redis_host)) > 1 ? split(":", var.redis_host)[1] : tostring(var.redis_port)
    REDIS_DB   = var.redis_db

    JWT_EXPIRES_IN  = "30d"
    APPLE_CLIENT_ID = var.apple_client_id

    EXTERNAL_VENDOR   = "telegram"
    TELEGRAM_API_BASE = "https://api.telegram.org"

    ASSISTANT_AI_PROVIDER       = "anthropic"
    ASSISTANT_MODEL_MAIN        = var.assistant_model_main
    ASSISTANT_MODEL_BACKGROUND  = var.assistant_model_background
    ASSISTANT_MAX_OUTPUT_TOKENS = "1024"
    ASSISTANT_AI_MAX_RETRIES    = "2"

    STT_PROVIDER             = "openai"
    STT_MODEL                = var.stt_model
    STT_TRANSLATE_TO_ENGLISH = "false"

    # Public HTTPS base the app registers the Telegram webhook against on boot (it appends
    # /assistant/telegram/webhook). Registration also needs TELEGRAM_BOT_TOKEN +
    # TELEGRAM_WEBHOOK_SECRET seeded (seed-secrets.sh) to actually succeed.
    ASSISTANT_WEBHOOK_URL = "https://${var.api_hostname}"
    # Public HTTPS base for the iOS universal link in the Telegram linking prompt; must match the app's
    # Associated Domains entitlement (applinks:…) and serve an apple-app-site-association file.
    ASSISTANT_APP_LINK_BASE_URL = var.assistant_app_link_base_url

    # Assistant orchestration knobs (formerly Zod defaults; now required, so set explicitly).
    ASSISTANT_MAX_TOOL_ROUNDTRIPS    = "8"
    ASSISTANT_MAX_SCHEDULE_FETCHES   = "5"
    ASSISTANT_MAX_CORRECTIONS        = "5"
    ASSISTANT_LINK_NONCE_TTL_SECONDS = "600"
    ASSISTANT_DEDUPE_TTL_SECONDS     = "3600"
    ASSISTANT_RECENT_WINDOW_SIZE     = "10"
    ASSISTANT_PRELOAD_HORIZON_DAYS   = "7"
    ASSISTANT_SUMMARIZE_THRESHOLD    = "20"

    # ask_user durable suspend/resume (v1 Story 5).
    ASSISTANT_ASK_USER_TTL_SECONDS     = "1800"
    ASSISTANT_ASK_USER_RETENTION_HOURS = "168"

    # v2 per-user serialization lock (Wave A) — RENEW must be strictly < TTL (enforced by a Zod boot guard).
    ASSISTANT_USER_LOCK_TTL_MS   = "30000"
    ASSISTANT_USER_LOCK_RENEW_MS = "10000"

    # v2 live-status surface — one real message edited in place (ADR 0053). TTL of
    # the per-turn Redis StatusSession pointer. (The former dot/word animation
    # intervals were removed with the draft surface.)
    ASSISTANT_STATUS_SESSION_TTL_SECONDS = "120"
    # Status-surface ASCII braille spinner tick interval (ms, R1 / ADR 0057). Kept
    # ~1000 (never sub-second) to stay clear of Telegram editMessageText 429
    # flood-control.
    ASSISTANT_STATUS_SPINNER_INTERVAL_MS = "1000"

    # v2 message debounce + queue-after (Wave C, Story 14a).
    ASSISTANT_DEBOUNCE_WINDOW_MS      = "2000"
    ASSISTANT_DEBOUNCE_QUEUE_AFTER_MS = "750"

    # v2 reply-keyboard latest-button context (Wave E, Story 16).
    ASSISTANT_LAST_BUTTON_TTL_SECONDS = "300"

    # Last-message-language tracker (R2 / ADR 0055) TTL (seconds): per-user last
    # resolved loading-status locale, borrowed by the next turn's voice pre-STT
    # "Listening…" line. Sticky, self-cleaning backstop — keep it long (~7 days).
    ASSISTANT_LAST_MESSAGE_LANGUAGE_TTL_SECONDS = "604800"
  }
}

resource "aws_ssm_parameter" "config" {
  for_each = local.app_config

  name  = "/${var.project}/production/${each.key}"
  type  = "String"
  value = each.value
}

# Cloudflare origin cert + key — TF-managed so they survive EC2 replacement (the instance-local
# copy at /opt/cue/origin/* is wiped when an AMI roll recreates the box). Read directly from the
# gitignored origin-cert.pem / origin-key.pem files in this directory, so `terraform apply` is
# self-contained (no TF_VAR/tfvars to set) as long as those two files are present. Stored base64-
# encoded so each value is single-line: deploy.sh sweeps every param under this path into app.env
# line-by-line, and a raw multi-line PEM would corrupt that loop. deploy.sh skips these two in the
# app.env sweep and base64-decodes them into /opt/cue/origin/{cert,key}.pem before `docker compose up`.
# SecureString → encrypted with aws/ssm; the instance role already has read + kms:Decrypt (iam.tf),
# so no new IAM is needed. (Standard tier caps a value at 4 KB; an RSA-2048/ECC origin key fits.)
resource "aws_ssm_parameter" "origin_cert" {
  name  = "/${var.project}/production/ORIGIN_CERT_PEM"
  type  = "SecureString"
  value = base64encode(file("${path.module}/origin-cert.pem"))
}

resource "aws_ssm_parameter" "origin_key" {
  name  = "/${var.project}/production/ORIGIN_KEY_PEM"
  type  = "SecureString"
  value = base64encode(file("${path.module}/origin-key.pem"))
}