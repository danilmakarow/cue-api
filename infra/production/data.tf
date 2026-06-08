data "aws_caller_identity" "current" {}

# Existing networking — referenced read-only.
data "aws_vpc" "main" {
  id = var.vpc_id
}

data "aws_subnet" "public" {
  id = var.public_subnet_id
}

# Existing RDS — read-only, only to resolve its live endpoint for app config.
data "aws_db_instance" "cue" {
  db_instance_identifier = var.rds_instance_id
}

# Latest Amazon Linux 2023 x86_64 AMI, kept current by AWS via a public SSM parameter.
data "aws_ssm_parameter" "al2023_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}