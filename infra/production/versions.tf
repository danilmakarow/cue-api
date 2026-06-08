terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }

  # Remote state in S3. Concrete values come from backend.hcl (see backend.hcl.example):
  #   terraform init -backend-config=backend.hcl
  backend "s3" {
    key          = "production/terraform.tfstate"
    encrypt      = true
    use_lockfile = true # S3-native locking; no DynamoDB table needed (TF >= 1.10)
  }
}
