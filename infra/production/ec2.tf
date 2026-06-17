resource "aws_instance" "app" {
  ami                    = data.aws_ssm_parameter.al2023_ami.value
  instance_type          = var.instance_type
  subnet_id              = var.public_subnet_id
  vpc_security_group_ids = [aws_security_group.app.id]
  iam_instance_profile   = aws_iam_instance_profile.app.name

  # Bootstrap: install Docker + Compose + AWS CLI and lay down /opt/cue from the repo
  # files (embedded as base64 so their shell syntax isn't reinterpreted by Terraform).
  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    api_hostname = var.api_hostname
    region       = var.region
    ecr_registry = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.region}.amazonaws.com"
    ecr_repo     = aws_ecr_repository.api.name
    ssm_prefix   = "/${var.project}/production"
    compose_b64  = base64encode(file("${path.module}/../../docker-compose.prod.yml"))
    caddy_b64    = base64encode(file("${path.module}/../../Caddyfile"))
    deploy_b64   = base64encode(file("${path.module}/../../deploy/deploy.sh"))
  })

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required" # IMDSv2 only
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = 20
    encrypted   = true
  }

  tags = { Name = "${var.project}-api" }

  # The AMI comes from AWS's "latest AL2023" SSM pointer (data.tf), which moves whenever AWS publishes
  # a new image — and a changed AMI forces instance replacement. Ignore that drift so a routine apply
  # never destroys the running box; an OS/AMI refresh is then a deliberate
  # `terraform apply -replace=aws_instance.app` (the self-heal user_data brings the new box back up).
  lifecycle {
    ignore_changes = [ami]
  }
}

output "instance_id" {
  value = aws_instance.app.id
}