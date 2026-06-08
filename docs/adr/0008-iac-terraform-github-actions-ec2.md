# 0008 — iac-terraform-github-actions-ec2

- **Status**: Accepted
- **Date**: 2026-06-05
- **Deciders**: Danil Makarov

## Context

cue-api needs production hosting and a CI/CD pipeline (build → standards/test → deploy on
`master`). Learning Infrastructure as Code and GitHub Actions is an explicit goal. An RDS
PostgreSQL instance already exists and should be reused; two manually-built EC2 runner
boxes exist; the API should sit behind Cloudflare on an Elastic IP. We must choose an IaC
tool, a runner model, an image-delivery mechanism, and how to treat existing resources.

## Decision

We provision cue-api's production infrastructure with **Terraform**, and deliver it through
**GitHub Actions on GitHub-hosted runners** authenticated to AWS via **OIDC** (no static
keys). CI builds a **Docker image pushed to ECR**; a single Terraform-managed **EC2 behind
Cloudflare** pulls and runs it, triggered by **AWS SSM Run Command** (no inbound SSH). The
existing **RDS is reused** via a new `cue` database and is **referenced, not imported**, in
Terraform.

## Consequences

- ✅ Infra is reproducible from code; the app stack needs no console clicking.
- ✅ Keyless deploys (OIDC) and no open SSH (SSM) — small attack surface.
- ✅ Immutable, SHA-tagged images give exact, repeatable rollbacks.
- ✅ The live RDS is never in Terraform's blast radius; reuse costs $0 extra.
- ✅ Going GitHub-hosted frees the two manual runner EC2s (likely a net cost saving).
- ⚠️ Single instance: a deploy is a brief restart, not zero-downtime.
- ⚠️ With hosted runners we don't operate a runner — less "runner ops" learning (revisitable).
- ⚠️ Migrations run on app boot, coupling migrate to startup (acceptable for one instance).
- ⚠️ Terraform state bootstrap is a one-time manual step (inherent chicken-and-egg).
- ⚠️ Prod build requires resolving `@/*` path aliases (see spec open question / `tsc-alias`).

## Alternatives considered

### AWS CDK / Pulumi (TypeScript)
Same language as the app, but weaker at adopting existing resources; CDK is AWS-only and
can't manage Cloudflare. Terraform is the more transferable skill — the stated goal.

### Self-hosted runners on the existing EC2s
Reuses the boxes and gives in-VPC RDS access, but adds patching/security burden;
GitHub-hosted + OIDC is zero-ops and keyless. Can be added later for the deploy job only.

### Build artifact + pm2/systemd over SSH
Simplest, but no immutable artifact, weaker rollback, and needs inbound SSH. ECR + SSM win
on reproducibility and a closed network surface.

### Import existing RDS / EC2 into Terraform
A single source of truth, but a careless plan could propose replacing a live database.
Referenced read-only instead.

## References

- Spec: [deployment-and-cicd](../specs/deployment-and-cicd.md)
- The four decisions: Terraform · GitHub-hosted + OIDC · Docker→ECR · reference-existing.
