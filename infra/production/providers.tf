provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "cue"
      App       = "cue-api"
      ManagedBy = "terraform"
    }
  }
}

# Configured but unused until Phase 3 (edge). The token is only required when Cloudflare
# resources are added; an empty value is fine for the Phase 1 ECR-only apply.
provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
