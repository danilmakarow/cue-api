# syntax=docker/dockerfile:1

# ── Stage 1: build ────────────────────────────────────────────────
FROM node:20-slim AS builder
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# pnpm-workspace.yaml carries the pnpm-11 build-script allow-list (ffmpeg-static,
# esbuild, …). It must be present BEFORE install or those postinstalls are skipped
# and the ffmpeg binary never lands in the image.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
# NOTE: the runtime entry `node dist/main` requires the `@/*` path aliases to be
# rewritten to relative paths. `nest build` (plain tsc) does NOT do this. Adopt
# `tsc-alias` (`"build": "nest build && tsc-alias"`) — see
# docs/specs/deployment-and-cicd.md → Open questions. The image builds regardless,
# but the container won't boot until the build emits alias-free JS.
RUN pnpm build

# Drop dev dependencies so only runtime deps are carried into the final image.
RUN pnpm prune --prod

# ── Stage 2: runtime ──────────────────────────────────────────────
FROM node:20-slim AS runner
ENV NODE_ENV=production
WORKDIR /app
RUN useradd --system --uid 1001 --create-home cue

COPY --from=builder --chown=cue:cue /app/node_modules ./node_modules
COPY --from=builder --chown=cue:cue /app/dist ./dist
COPY --chown=cue:cue package.json ./

USER cue
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations run on boot when DB_RUN_MIGRATIONS=true (compiled dist/migrations/*.js).
CMD ["node", "dist/main"]
