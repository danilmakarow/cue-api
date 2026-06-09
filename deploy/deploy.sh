#!/usr/bin/env bash
# Runs ON the app EC2, invoked by GitHub Actions via SSM Run Command:
#
#   AWS_REGION=<r> ECR_REGISTRY=<acct>.dkr.ecr.<r>.amazonaws.com /opt/cue/deploy.sh <image-tag>
#
# Pulls the new image, renders runtime config from SSM Parameter Store, lays down the Caddy
# origin cert/key (also from SSM), and restarts the stack. Migrations run on app boot
# (DB_RUN_MIGRATIONS=true), so there is no separate migrate step here.
set -euo pipefail

IMAGE_TAG="${1:?usage: deploy.sh <image-tag>}"
AWS_REGION="${AWS_REGION:?AWS_REGION required}"
ECR_REGISTRY="${ECR_REGISTRY:?ECR_REGISTRY required}" # <acct>.dkr.ecr.<region>.amazonaws.com
ECR_REPO="${ECR_REPO:-cue-api}"
SSM_PREFIX="${SSM_PREFIX:-/cue/production}"
APP_DIR="${APP_DIR:-/opt/cue}"
LOG_GROUP="${LOG_GROUP:-/cue/production}" # CloudWatch group the awslogs driver writes to

export CUE_IMAGE="${ECR_REGISTRY}/${ECR_REPO}:${IMAGE_TAG}"
export AWS_REGION # docker compose interpolates ${AWS_REGION} for the awslogs driver

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
      key="${name##*/}"
      # The origin cert/key are Caddy files, not app env — written separately below. They are
      # stored base64-encoded (single-line) so this line-by-line sweep can't be corrupted by
      # their PEM newlines, and skipped here so the private key never enters the api container.
      case "${key}" in ORIGIN_CERT_PEM | ORIGIN_KEY_PEM) continue ;; esac
      printf '%s=%s\n' "${key}" "${value}"
    done > "${APP_DIR}/app.env"

echo "==> Writing Caddy origin cert/key from SSM (${SSM_PREFIX})"
install -d -m 755 "${APP_DIR}/origin"
# Decode one base64-encoded SSM SecureString into a file with the given mode.
write_origin_pem() { # <ssm-name-suffix> <dest-file> <chmod-mode>
  local encoded
  encoded="$(aws ssm get-parameter --region "${AWS_REGION}" \
    --name "${SSM_PREFIX}/$1" --with-decryption \
    --query 'Parameter.Value' --output text 2>/dev/null || true)"
  if [ -z "${encoded}" ] || [ "${encoded}" = "None" ]; then
    echo "!! Missing SSM param ${SSM_PREFIX}/$1 — set TF_VAR_origin_* and re-apply." >&2
    exit 1
  fi
  printf '%s' "${encoded}" | base64 -d > "$2"
  chmod "$3" "$2"
}
write_origin_pem ORIGIN_CERT_PEM "${APP_DIR}/origin/cert.pem" 644
write_origin_pem ORIGIN_KEY_PEM  "${APP_DIR}/origin/key.pem"  600

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
# With the awslogs driver `docker compose logs` can't read locally — pull from CloudWatch instead
# (fall back to docker logs for an older box still on the json-file driver).
echo "!! Recent api logs (CloudWatch ${LOG_GROUP}, stream api):" >&2
aws logs tail "${LOG_GROUP}" --region "${AWS_REGION}" \
  --log-stream-names api --since 5m --format short >&2 2>/dev/null \
  || docker compose -f docker-compose.prod.yml logs --tail=80 api >&2 2>/dev/null \
  || echo "   (no logs available — check CloudWatch ${LOG_GROUP})" >&2
echo "!! Rollback: re-run this script with the previous image tag." >&2
exit 1
