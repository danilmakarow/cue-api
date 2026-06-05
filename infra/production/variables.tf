variable "region" {
  description = "AWS region where the existing RDS/VPC live."
  type        = string
}

variable "project" {
  description = "Resource name prefix."
  type        = string
  default     = "cue"
}

# ── Phase 2 (compute) — fill from your AWS account ───────────────
variable "vpc_id" {
  description = "Existing VPC that hosts the RDS instance."
  type        = string
  default     = ""
}

variable "public_subnet_id" {
  description = "Public subnet for the app EC2 + Elastic IP."
  type        = string
  default     = ""
}

variable "rds_security_group_id" {
  description = "Security group on the existing RDS instance; we add an ingress rule for the app SG."
  type        = string
  default     = ""
}

variable "instance_type" {
  description = "App EC2 size."
  type        = string
  default     = "t3.small"
}

# ── GitHub OIDC (Phase 5) ────────────────────────────────────────
variable "github_repo" {
  description = "owner/repo permitted to assume the deploy role."
  type        = string
  default     = "danilmakarow/cue-api"
}

# ── Phase 3 (edge) ───────────────────────────────────────────────
variable "cloudflare_api_token" {
  description = "Cloudflare API token (Zone:DNS edit + Zone settings)."
  type        = string
  sensitive   = true
  default     = ""
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone id for the domain."
  type        = string
  default     = ""
}

variable "api_hostname" {
  description = "Public hostname for the API, e.g. api.cue.example."
  type        = string
  default     = ""
}
