# Phase 3 — Edge. Cloudflare fronts the API: proxied DNS, Full (Strict) TLS, HSTS, and a
# rate-limit rule, with the origin reachable only from Cloudflare IP ranges (see security.tf).
# Cloudflare is authoritative for the whole makarov.my apex zone (a dedicated domain registered
# at Spaceship); makarov.app stays in Route53, untouched. No Route53 resources here.
#
# Secrets stay out of state (Option B): the Cloudflare API token comes from the
# TF_VAR_cloudflare_api_token env var, and the Caddy origin certificate is installed on the
# box out-of-band (see the Phase 3 owner-actions in docs/specs/deployment-and-cicd.md)
# rather than issued through Terraform, which would persist its private key in state.

locals {
  # "cue-api" — the record label under the Cloudflare apex zone.
  api_record_name = trimsuffix(var.api_hostname, ".${var.edge_zone_name}")
}

# The makarov.my zone already exists in Cloudflare (created out-of-band; nameservers set at
# Spaceship). Terraform references it read-only and manages the records/settings inside it.
data "cloudflare_zone" "edge" {
  account_id = var.cloudflare_account_id
  name       = var.edge_zone_name
}

# Proxied A record: public traffic hits Cloudflare, which re-encrypts to the EIP origin.
resource "cloudflare_record" "api" {
  zone_id = data.cloudflare_zone.edge.id
  name    = local.api_record_name
  type    = "A"
  value   = aws_eip.app.public_ip
  proxied = true
  ttl     = 1 # must be 1 (automatic) when proxied
  comment = "cue-api origin (Elastic IP)"
}

# Encryption + security posture: Full (Strict) so Cloudflare validates the origin cert,
# force HTTPS, a modern TLS floor, and HSTS.
resource "cloudflare_zone_settings_override" "edge" {
  zone_id = data.cloudflare_zone.edge.id

  settings {
    ssl                      = "strict" # Full (Strict): CF <-> origin over the origin cert
    always_use_https         = "on"
    automatic_https_rewrites = "on"
    min_tls_version          = "1.2"
    tls_1_3                  = "on"

    security_header {
      enabled            = true
      max_age            = 31536000 # 1 year
      include_subdomains = true
      nosniff            = true
      preload            = false # avoid the hard-to-reverse preload-list commitment
    }
  }
}

# Basic edge protection: one rate-limit rule (free tier). Cloudflare's L3/4 DDoS mitigation
# is always-on and automatic; managed WAF rulesets need a paid plan and are deferred.
resource "cloudflare_ruleset" "rate_limit" {
  zone_id = data.cloudflare_zone.edge.id
  name    = "cue-api rate limit"
  kind    = "zone"
  phase   = "http_ratelimit"

  rules {
    action      = "block"
    description = "Throttle abusive clients (per IP)"
    expression  = "true" # count all requests to the zone

    ratelimit {
      characteristics     = ["ip.src", "cf.colo.id"]
      period              = 10  # free plan only permits a 10s counting window
      requests_per_period = 100 # ~10 req/s per IP before a block (tune as needed)
      mitigation_timeout  = 10  # free plan: block duration matches the 10s period
    }
  }
}

output "api_url" {
  description = "Public API endpoint (live once the zone activates and the origin cert is installed)."
  value       = "https://${var.api_hostname}"
}
