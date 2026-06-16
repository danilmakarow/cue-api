# Non-secret runtime config only. Secrets (DB_PASSWORD, JWT_SECRET, *_API_KEY,
# TELEGRAM_*, REDIS_PASSWORD) are NOT managed here — they're seeded out-of-band by
# seed-secrets.sh so they never enter git or Terraform state. The instance role can read
# both these and the secrets (path-scoped grant in iam.tf); deploy.sh reads the whole path.
locals {
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

    EXTERNAL_VENDOR   = "telegram"
    TELEGRAM_API_BASE = "https://api.telegram.org"
    APPLE_CLIENT_ID   = var.apple_client_id

    ASSISTANT_AI_PROVIDER      = "anthropic"
    ASSISTANT_MODEL_MAIN       = var.assistant_model_main
    ASSISTANT_MODEL_BACKGROUND = var.assistant_model_background
    # Public HTTPS base the app registers the Telegram webhook against on boot (it appends
    # /assistant/telegram/webhook). Registration also needs TELEGRAM_BOT_TOKEN +
    # TELEGRAM_WEBHOOK_SECRET seeded (seed-secrets.sh) to actually succeed.
    ASSISTANT_WEBHOOK_URL = "https://${var.api_hostname}"
    STT_PROVIDER          = "openai"
    STT_MODEL             = var.stt_model
  }
}

resource "aws_ssm_parameter" "config" {
  for_each = local.app_config

  name  = "/${var.project}/production/${each.key}"
  type  = "String"
  value = each.value
}

# Cloudflare origin cert + key — TF-managed so they survive EC2 replacement (the instance-local
# copy at /opt/cue/origin/* is wiped when an AMI roll recreates the box). Stored base64-encoded so
# each value is single-line: deploy.sh sweeps every param under this path into app.env line-by-line,
# and a raw multi-line PEM would corrupt that loop. deploy.sh skips these two in the app.env sweep
# and base64-decodes them into /opt/cue/origin/{cert,key}.pem before `docker compose up`.
# SecureString → encrypted with aws/ssm; the instance role already has read + kms:Decrypt (iam.tf),
# so no new IAM is needed. (Standard tier caps a value at 4 KB; an RSA-2048/ECC origin key fits.)
resource "aws_ssm_parameter" "origin_cert" {
  name  = "/${var.project}/production/ORIGIN_CERT_PEM"
  type  = "SecureString"
  value = base64encode(var.origin_cert_pem)
}

resource "aws_ssm_parameter" "origin_key" {
  name  = "/${var.project}/production/ORIGIN_KEY_PEM"
  type  = "SecureString"
  value = base64encode(var.origin_key_pem)
}