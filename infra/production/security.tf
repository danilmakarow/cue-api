# App security group, attached to the EC2. The only inbound is HTTPS from Cloudflare's IP
# ranges (Phase 3), so the origin can't be reached around the proxy. Administration is via
# SSM Session Manager, not SSH.
resource "aws_security_group" "app" {
  name        = "${var.project}-api-app"
  description = "cue-api application instance"
  vpc_id      = var.vpc_id

  tags = { Name = "${var.project}-api-app" }
}

# Egress is broad (ingress is the controlled surface): the app needs 443 (ECR, SSM, the
# Redis SaaS over TLS, package mirrors), 5432 to RDS, and DNS. Tighten later if desired.
resource "aws_vpc_security_group_egress_rule" "app_all" {
  security_group_id = aws_security_group.app.id
  description       = "All egress (ingress is the controlled surface)"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# The single additive change to the EXISTING RDS security group: allow Postgres from the
# app SG. The RDS instance itself is never managed by Terraform.
resource "aws_vpc_security_group_ingress_rule" "rds_from_app" {
  security_group_id            = var.rds_security_group_id
  description                  = "cue-api app to RDS (Postgres 5432)"
  referenced_security_group_id = aws_security_group.app.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

# ── Phase 3 edge: HTTPS only from Cloudflare ─────────────────────────────────────────────
# The origin is the Elastic IP (IPv4) and the proxied A record points there, so Cloudflare
# connects over IPv4 — we allow 443 only from Cloudflare's published IPv4 ranges. No :80 is
# opened: Cloudflare terminates HTTP and "Always Use HTTPS" redirects at the edge, so the
# origin never needs it. This is what hides the origin — a direct hit to the EIP is dropped.
data "cloudflare_ip_ranges" "cloudflare" {}

resource "aws_vpc_security_group_ingress_rule" "https_from_cloudflare" {
  for_each = toset(data.cloudflare_ip_ranges.cloudflare.ipv4_cidr_blocks)

  security_group_id = aws_security_group.app.id
  description       = "Cloudflare edge to origin HTTPS (443)"
  cidr_ipv4         = each.value
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

output "app_security_group_id" {
  value = aws_security_group.app.id
}