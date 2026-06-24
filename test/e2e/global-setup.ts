import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { E2E_ENV_FILE } from './load-env';

/** Repo root, derived from this file's location (test/e2e → ../../). */
const REPO_ROOT = resolve(__dirname, '../../');

/**
 * The DEDICATED e2e compose file — a separate Compose project (cue-api-test) with
 * its own containers and volumes, isolated from `docker-compose.dev.yml`, so the
 * teardown's `down -v` can never wipe the developer's dev database.
 */
const COMPOSE_FILE = 'docker-compose.test.yml';

/**
 * Jest globalSetup: brings up the dedicated test Postgres + Redis containers from
 * `docker-compose.test.yml`, sourcing ports/credentials from `.env.test` so the
 * published host ports match what the app connects to. `--wait` blocks until
 * both healthchecks pass, so the very first `app.init()` finds a live DB/Redis.
 * Set `E2E_SKIP_DOCKER=1` to run against already-running infra (faster local
 * iteration); the harness still flushes/truncates between tests.
 */
const globalSetup = async (): Promise<void> => {
  if (process.env.E2E_SKIP_DOCKER === '1') {
    return;
  }

  console.log('\n[e2e] Starting Postgres + Redis via docker compose --wait …');

  execFileSync(
    'docker',
    [
      'compose',
      '-f',
      COMPOSE_FILE,
      '--env-file',
      E2E_ENV_FILE,
      'up',
      '-d',
      '--wait',
    ],
    { cwd: REPO_ROOT, stdio: 'inherit' },
  );
};

export default globalSetup;
