# Container logs ship here via the awslogs Docker driver (docker-compose.prod.yml: api + caddy).
# The instance role already has logs:CreateLogGroup/CreateLogStream/PutLogEvents on /${project}/*
# (iam.tf "CwLogs"), so no IAM change is needed. The group name must match awslogs-group in the
# compose file and LOG_GROUP in deploy.sh; streams are "api" and "caddy".
#
# Apply this BEFORE the box runs the new compose: awslogs-create-group is "false", so a missing
# group makes the containers fail to start.
#
# Read the logs:  aws logs tail /cue/production --follow --region eu-north-1
resource "aws_cloudwatch_log_group" "app" {
  name              = "/${var.project}/production"
  retention_in_days = var.log_retention_days
}

output "log_group" {
  description = "CloudWatch Logs group for container logs. Tail: aws logs tail <name> --follow"
  value       = aws_cloudwatch_log_group.app.name
}
