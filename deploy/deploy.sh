#!/usr/bin/env bash
# Runs ON the app EC2, invoked by GitHub Actions via SSM Run Command:
#
#   AWS_REGION=<r> ECR_REGISTRY=<acct>.dkr.ecr.<r>.amazonaws.com /opt/cue/deploy.sh <image-tag>
#
# Pulls the new image, renders runtime config from SSM Parameter Store, and restarts the
# stack. Migrations run on app boot (DB_RUN_MIGRATIONS=true), so there is no separate
# migrate step here.
set -euo pipefail

IMAGE_TAG="${1:?usage: deploy.sh <image-tag>}"
AWS_REGION="${AWS_REGION:?AWS_REGION required}"
ECR_REGISTRY="${ECR_REGISTRY:?ECR_REGISTRY required}" # <acct>.dkr.ecr.<region>.amazonaws.com
ECR_REPO="${ECR_REPO:-cue-api}"
SSM_PREFIX="${SSM_PREFIX:-/cue/production}"
APP_DIR="${APP_DIR:-/opt/cue}"

export CUE_IMAGE="${ECR_REGISTRY}/${ECR_REPO}:${IMAGE_TAG}"

echo "==> ECR login (${ECR_REGISTRY})"
aws ecr get-login-password --region "${AWS_REGION}" \
  | docker login --username AWS --password-stdin "${ECR_REGISTRY}"

echo "==> Pulling ${CUE_IMAGE}"
docker pull "${CUE_IMAGE}"

echo "==> Rendering ${APP_DIR}/app.env from SSM (${SSM_PREFIX})"
umask 077
aws ssm get-parameters-by-path \
  --region "${AWS_REGION}" \
  --path "${SSM_PREFIX}" \
  --with-decryption \
  --recursive \
  --query 'Parameters[].[Name,Value]' --output text \
  | while IFS=$'\t' read -r name value; do
      printf '%s=%s\n' "${name##*/}" "${value}"
    done > "${APP_DIR}/app.env"

echo "==> Starting stack"
cd "${APP_DIR}"
docker compose -f docker-compose.prod.yml up -d --remove-orphans

echo "==> Waiting for health"
for attempt in $(seq 1 30); do
  if docker compose -f docker-compose.prod.yml exec -T api \
       node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    echo "==> Healthy. Pruning dangling images."
    docker image prune -f
    exit 0
  fi
  echo "   not ready ($attempt/30)"
  sleep 3
done

echo "!! Health check failed after deploy of ${IMAGE_TAG}" >&2
docker compose -f docker-compose.prod.yml logs --tail=80 api >&2
echo "!! Rollback: re-run this script with the previous image tag." >&2
exit 1
