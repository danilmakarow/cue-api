# Phase 5 — Continuous delivery. Keyless GitHub Actions → AWS via OIDC: the deploy workflow
# assumes this role (no static keys), pushes the image to ECR, then runs deploy/deploy.sh on
# the box through SSM Run Command. The instance role (iam.tf) owns the runtime side (ECR pull,
# SSM param read); this role only pushes images and dispatches the deploy.

# GitHub's OIDC identity provider. AWS validates the provider's TLS certificate against trusted
# CAs, so the thumbprint is no longer used for token.actions.githubusercontent.com — the
# well-known values are kept only because the API still requires the field.
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  thumbprint_list = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c58a3a8518e8759bf075b76b750d4f2df264fcd",
  ]
}

# Trust policy: only this repo, and only the master branch / production environment, may assume
# the role. The production environment subject lets GitHub environment protection (required
# reviewers) gate releases; the master ref subject keeps it working if that gate is removed.
data "aws_iam_policy_document" "deploy_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    effect  = "Allow"

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "repo:${var.github_repo}:environment:production",
        "repo:${var.github_repo}:ref:refs/heads/master",
      ]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name               = "${var.project}-api-deploy"
  description        = "GitHub Actions OIDC: push to ECR + SSM deploy"
  assume_role_policy = data.aws_iam_policy_document.deploy_assume.json
}

data "aws_iam_policy_document" "deploy" {
  # ECR auth token — account-wide, as the API requires.
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  # Push (and read) image layers for this repository only.
  statement {
    sid = "EcrPush"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage",
    ]
    resources = [aws_ecr_repository.api.arn]
  }

  # Resolve the target instance id by Name tag (DescribeInstances has no resource-level scoping).
  statement {
    sid       = "Ec2Describe"
    actions   = ["ec2:DescribeInstances"]
    resources = ["*"]
  }

  # Dispatch the deploy: SendCommand against the AWS-RunShellScript document...
  statement {
    sid     = "SsmSendCommandDocument"
    actions = ["ssm:SendCommand"]
    # AWS-owned document → its ARN has an EMPTY account field; including the account id
    # makes the resource not match and SendCommand is denied.
    resources = ["arn:aws:ssm:${var.region}::document/AWS-RunShellScript"]
  }

  # ...targeted only at the cue-api instance. Tag-scoped, so it survives instance replacement
  # (a user_data change recreates the box with a new id but the same Name tag).
  statement {
    sid       = "SsmSendCommandInstance"
    actions   = ["ssm:SendCommand"]
    resources = ["arn:aws:ec2:${var.region}:${data.aws_caller_identity.current.account_id}:instance/*"]

    condition {
      test     = "StringEquals"
      variable = "ssm:resourceTag/Name"
      values   = ["${var.project}-api"]
    }
  }

  # Poll the command result so the workflow can gate on deploy success.
  statement {
    sid       = "SsmReadResult"
    actions   = ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "${var.project}-api-deploy"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}

output "deploy_role_arn" {
  description = "Set as the GitHub repo variable AWS_DEPLOY_ROLE_ARN (consumed by deploy.yml)."
  value       = aws_iam_role.deploy.arn
}
