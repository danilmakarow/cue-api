# infra — Terraform for cue-api

See [`docs/specs/deployment-and-cicd.md`](../docs/specs/deployment-and-cicd.md) for the
full design and [`docs/adr/0008`](../docs/adr/0008-iac-terraform-github-actions-ec2.md)
for the decision.

## Layout

```
bootstrap/    one-time: the S3 bucket that stores Terraform state (run with LOCAL state)
production/   everything else: ECR now; EC2 / Elastic IP / SGs / IAM OIDC / SSM / Cloudflare next
```

## Order of operations

1. **Bootstrap the state bucket** (once):

   ```bash
   cd infra/bootstrap
   terraform init
   terraform apply -var="region=<your-region>" -var="state_bucket_name=cue-tfstate-<unique>"
   ```

2. **Point production at that bucket** — copy `production/backend.hcl.example` to
   `production/backend.hcl` and fill in the bucket + region.

3. **Plan/apply production**:

   ```bash
   cd infra/production
   terraform init -backend-config=backend.hcl
   terraform apply -var="region=<your-region>"
   ```

## Status

- ✅ `bootstrap/` — ready.
- ✅ `production/ecr.tf` — the ECR repository (Phase 1). Apply-able now.
- ⏳ Compute (EC2/EIP/SG), IAM OIDC, SSM params, and Cloudflare are added in Phases 2–3,
  once these are known: **region, VPC id, a public subnet id, the RDS security-group id**,
  and the **Cloudflare zone + API token**. The variables are already declared in
  `production/variables.tf`.

State is never committed — `*.tfstate*` and `backend.hcl` are gitignored.
