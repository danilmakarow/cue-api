# bootstrap

Creates the S3 bucket that backs Terraform state for `infra/production`. This is the
chicken-and-egg every Terraform setup solves once: it runs with **local** state (there is
no `backend` block here), and its only job is to create the remote-state bucket.

```bash
terraform init
terraform apply -var="region=<region>" -var="state_bucket_name=cue-tfstate-<unique>"
```

Run it once. The resulting `terraform.tfstate` for the bucket itself stays local and is
gitignored — losing it only means you'd re-import or recreate one bucket, nothing else.
