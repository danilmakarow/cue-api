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

# Cloudflare manages the Phase 3 edge (zone, DNS, TLS, rate-limit). Set the API token in
# terraform.tfvars (gitignored) or via TF_VAR_cloudflare_api_token — never in git or state.
provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
