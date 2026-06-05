# Phase 1 — the container registry. This is apply-able now (needs only region + AWS creds).

resource "aws_ecr_repository" "api" {
  name                 = "${var.project}-api"
  image_tag_mutability = "IMMUTABLE" # SHA tags never get overwritten — exact rollbacks

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "api" {
  repository = aws_ecr_repository.api.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep only the last 10 images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 10
        }
        action = { type = "expire" }
      }
    ]
  })
}

output "ecr_repository_url" {
  description = "Push target for the CD workflow."
  value       = aws_ecr_repository.api.repository_url
}
