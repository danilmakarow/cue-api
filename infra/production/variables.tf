variable "region" {
  description = "AWS region where the existing RDS/VPC live."
  type        = string
  default     = "eu-north-1"
}

variable "project" {
  description = "Resource name prefix."
  type        = string
  default     = "cue"
}

# ── Existing infrastructure (discovered 2026-06-06; referenced read-only) ──
variable "vpc_id" {
  description = "Existing (default) VPC that hosts the RDS instance."
  type        = string
  default     = "vpc-02b006a0af428b08e"
}

variable "public_subnet_id" {
  description = "Public subnet for the app EC2 + Elastic IP (eu-north-1a)."
  type        = string
  default     = "subnet-05d284c27d3c4a954"
}

variable "rds_instance_id" {
  description = "Existing RDS instance identifier (used to read its live endpoint)."
  type        = string
  default     = "database-1"
}

variable "rds_security_group_id" {
  description = "Security group on the existing RDS; we add one ingress rule for the app SG."
  type        = string
  default     = "sg-05f54517be0f41c56"
}

variable "instance_type" {
  description = "App EC2 size."
  type        = string
  default     = "t3.small"
}

# ── App runtime config (non-secret; secrets are seeded out-of-band — see seed-secrets.sh) ──
variable "apple_client_id" {
  description = "Apple Services/bundle ID that signs identity tokens."
  type        = string
  default     = "makarov.cue"
}

variable "redis_host" {
  description = "External Redis (SaaS) host, optionally \"host:port\". Set in terraform.tfvars (gitignored)."
  type        = string
}

variable "redis_port" {
  description = "External Redis port."
  type        = number
  default     = 6379
}

variable "redis_db" {
  description = "External Redis logical DB index."
  type        = string
  default     = "0"
}

variable "assistant_model_main" {
  description = "Anthropic model for reasoning / tool use."
  type        = string
  default     = "claude-sonnet-4-5"
}

variable "assistant_model_background" {
  description = "Anthropic model for background tasks."
  type        = string
  default     = "claude-haiku-4-5"
}

variable "stt_model" {
  description = "OpenAI speech-to-text model."
  type        = string
  default     = "gpt-4o-mini-transcribe"
}

variable "assistant_app_link_base_url" {
  description = "Public HTTPS base for the iOS universal link in the Telegram linking prompt. Must match the iOS app's Associated Domains entitlement (currently applinks:cue.ngrok.app) and serve a /.well-known/apple-app-site-association file. Swap to a stable domain when the app does."
  type        = string
  default     = "https://cue.ngrok.app"
}

# ── GitHub OIDC (Phase 5) ──
variable "github_repo" {
  description = "owner/repo permitted to assume the deploy role."
  type        = string
  default     = "danilmakarow/cue-api"
}

# ── Phase 3 (edge) ──
variable "api_hostname" {
  description = "Public hostname for the API."
  type        = string
  default     = "cue-api.makarov.my"
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token. Set in terraform.tfvars (gitignored) or via TF_VAR_cloudflare_api_token — never commit it."
  type        = string
  sensitive   = true
  default     = ""
}

variable "cloudflare_account_id" {
  description = "Cloudflare account that owns the delegated zone. Required for the Phase 3 edge apply."
  type        = string
  default     = ""
}

variable "edge_zone_name" {
  description = "Apex domain managed by Cloudflare (registered at Spaceship); the API host lives under it."
  type        = string
  default     = "makarov.my"
}

# NOTE: the Cloudflare origin cert + key are NOT variables — ssm.tf reads them directly from the
# gitignored origin-cert.pem / origin-key.pem files in this directory. They still enter Terraform
# state via the SSM SecureString resources (state lives in the encrypted S3 backend; treat it as
# sensitive). To rotate: replace those two files and re-apply.

# ── Observability ──
variable "log_retention_days" {
  description = "CloudWatch retention for container logs (/cue/production)."
  type        = number
  default     = 30
}