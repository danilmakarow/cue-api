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

# Cloudflare manages the Phase 3 edge (zone, DNS, TLS, rate-limit). Supply the API token
# out-of-band via TF_VAR_cloudflare_api_token (env) — never in git or state.
provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
