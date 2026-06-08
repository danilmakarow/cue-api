variable "region" {
  description = "AWS region — must match where the RDS/EC2 live."
  type        = string
}

variable "state_bucket_name" {
  description = "Globally-unique S3 bucket name for Terraform state, e.g. cue-tfstate-<unique>."
  type        = string
}
