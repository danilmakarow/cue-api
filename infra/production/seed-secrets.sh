#!/usr/bin/env bash
# Seeds the cue-api SecureString secrets into SSM Parameter Store (Option B: secrets live
# outside Terraform — never in git or TF state). Run once with your IAM-user credentials,
# AFTER `terraform apply` and BEFORE the first deploy.
#
#   ./seed-secrets.sh
#
# Each value is read from a hidden prompt and written straight to SSM. Nothing is stored
# on disk. To rotate later, re-run this (or a single `aws ssm put-parameter ... --overwrite`).
set -euo pipefail

REGION="${AWS_REGION:-eu-north-1}"
PREFIX="/cue/production"

put() {
  local name="$1"
  read -rsp "Value for ${PREFIX}/${name}: " value
  echo
  if [ -z "${value}" ]; then
    echo "  (skipped — empty)"
    return
  fi
  aws ssm put-parameter \
    --region "${REGION}" \
    --name "${PREFIX}/${name}" \
    --type SecureString \
    --value "${value}" \
    --overwrite >/dev/null
  echo "  ✓ ${PREFIX}/${name}"
}

echo "Seeding SecureString secrets under ${PREFIX} (region ${REGION})"
echo "Press Enter to skip any you don't have yet."
echo

for secret in \
  DB_PASSWORD \
  JWT_SECRET \
  TELEGRAM_BOT_TOKEN \
  TELEGRAM_WEBHOOK_SECRET \
  ANTHROPIC_API_KEY \
  OPENAI_API_KEY \
  REDIS_PASSWORD; do
  put "${secret}"
done

echo
echo "Done. Verify with: aws ssm get-parameters-by-path --path ${PREFIX} --region ${REGION} --query 'Parameters[].Name'"