import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { E2E_ENV_FILE } from './load-env';

/** Repo root, derived from this file's location (test/e2e → ../../). */
const REPO_ROOT = resolve(__dirname, '../../');

/**
 * The DEDICATED e2e compose file — a separate Compose project (cue-api-test) with
 * its own containers and volumes, isolated from `docker-compose.dev.yml`, so the
 * `down -v` below can never wipe the developer's dev database.
 */
const COMPOSE_FILE = 'docker-compose.test.yml';

/**
 * Jest globalTeardown: tears the dedicated test Postgres + Redis containers down
 * and removes their volumes (`down -v`) so each e2e run starts from a clean schema
 * (the harness re-runs migrations on boot). Because this targets the isolated
 * cue-api-test project, it only ever wipes test data. Skipped when
 * `E2E_SKIP_DOCKER=1`, leaving already-running infra in place.
 */
const globalTeardown = async (): Promise<void> => {
  if (process.env.E2E_SKIP_DOCKER === '1') {
    return;
  }

  execFileSync(
    'docker',
    ['compose', '-f', COMPOSE_FILE, '--env-file', E2E_ENV_FILE, 'down', '-v'],
    { cwd: REPO_ROOT, stdio: 'inherit' },
  );
};

export default globalTeardown;
