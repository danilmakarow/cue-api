# One-time bootstrap: the S3 bucket that stores Terraform state for infra/production.
# Run this with LOCAL state (no backend block here) exactly once:
#
#   terraform init
#   terraform apply -var="region=<region>" -var="state_bucket_name=cue-tfstate-<unique>"
#
# Terraform >= 1.10 supports native S3 state locking (use_lockfile), so no DynamoDB
# lock table is required.

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

resource "aws_s3_bucket" "tfstate" {
  bucket = var.state_bucket_name

  # State is the source of truth for live infra — never let a plan destroy it.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket                  = aws_s3_bucket.tfstate.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

output "state_bucket_name" {
  description = "Use this as the `bucket` in infra/production/backend.hcl."
  value       = aws_s3_bucket.tfstate.id
}
