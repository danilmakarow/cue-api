import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Absolute path to the e2e env file. Single-sourced so the jest globalSetup
 * (docker compose --env-file) and the in-process loader agree on which file
 * drives both the containers' published ports and the app's connection config.
 */
export const E2E_ENV_FILE = resolve(__dirname, '../../.env.test');

/**
 * Parses a minimal dotenv file into key/value pairs. Supports `KEY=value`
 * lines, blank lines, and `#` comments; an empty value (`KEY=`) is preserved as
 * an empty string (needed for password-less Redis and the falsy webhook URL).
 * Deliberately tiny so the e2e harness needs no `dotenv` runtime dependency.
 */
const parseEnvFile = (contents: string): Record<string, string> => {
  const result: Record<string, string> = {};

  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();

    if (!line || line.startsWith('#')) {
      continue;
    }

    const equalsIndex = line.indexOf('=');

    if (equalsIndex === -1) {
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();
    const value = line.slice(equalsIndex + 1).trim();

    result[key] = value;
  }

  return result;
};

/**
 * Loads `.env.test` into `process.env` BEFORE AppModule (and thus
 * `@nestjs/config`) is imported. `@nestjs/config` never overrides an
 * already-present `process.env` value, so seeding it here makes the e2e config
 * win over the committed `.env` (which points at remote infra). Existing
 * `process.env` keys are left untouched so a CI-injected override (e.g. a real
 * ANTHROPIC_API_KEY) still takes precedence.
 */
export const loadE2eEnv = (): void => {
  if (!existsSync(E2E_ENV_FILE)) {
    throw new Error(
      `E2E env file not found at ${E2E_ENV_FILE}. Copy .env.example to .env.test ` +
        'and point DB/Redis at the local docker-compose infra before running test:e2e.',
    );
  }

  const parsed = parseEnvFile(readFileSync(E2E_ENV_FILE, 'utf8'));

  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
};
