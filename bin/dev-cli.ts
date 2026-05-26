import 'reflect-metadata';

import { INestApplicationContext, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../src/app.module';
import { AuthService } from '../src/modules/auth/auth.service';
import { UserDatabaseService } from '../src/modules/database/services';

const logger = new Logger('DevCli');

/**
 * Supported CLI subcommands. Kept as a union so the dispatcher is exhaustive.
 */
type Command = 'create-user' | 'issue-token' | 'help';

/**
 * Minimal positional parser: supports `--flag=value` and `--flag value`.
 * Returns a record of flag → string. Extra positional args are ignored.
 */
const parseFlags = (args: string[]): Record<string, string> => {
  const result: Record<string, string> = {};

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (!token.startsWith('--')) continue;

    const stripped = token.slice(2);
    const equalsIndex = stripped.indexOf('=');

    if (equalsIndex >= 0) {
      const key = stripped.slice(0, equalsIndex);
      const value = stripped.slice(equalsIndex + 1);
      result[key] = value;
      continue;
    }

    const next = args[index + 1];

    if (next !== undefined && !next.startsWith('--')) {
      result[stripped] = next;
      index += 1;
      continue;
    }

    result[stripped] = 'true';
  }

  return result;
};

/**
 * Prints the help banner listing every supported subcommand and flag.
 */
const printHelp = (): void => {
  console.log(`
Cue dev-cli — break-glass utilities. Never expose this on a production host.

Usage:
  pnpm dev-cli <command> [flags]

Commands:
  create-user     Create a user (and seed their default calendar).
                    --appleUserId <string>   required; stable identifier for the user
                    --email <string>         optional
                    --displayName <string>   optional
                    --timezone <iana>        optional; defaults to UTC

  issue-token     Mint a JWT access token for an existing user.
                    --userId <uuid>          one of userId / appleUserId required
                    --appleUserId <string>

  help            Show this banner.
`);
};

/**
 * Runs `create-user` — validates required flags, provisions the user with a
 * default calendar, and prints the resulting user id.
 */
const runCreateUser = async (
  app: INestApplicationContext,
  flags: Record<string, string>,
): Promise<void> => {
  const appleUserId = flags.appleUserId;

  if (!appleUserId) {
    logger.error('create-user: --appleUserId is required');
    process.exitCode = 1;

    return;
  }

  const authService = app.get(AuthService);
  const user = await authService.provisionUser({
    appleUserId,
    email: flags.email ?? null,
    displayName: flags.displayName ?? null,
    timezone: flags.timezone,
  });

  console.log(
    JSON.stringify(
      {
        id: user.id,
        appleUserId: user.appleUserId,
        email: user.email,
        displayName: user.displayName,
        timezone: user.timezone,
      },
      null,
      2,
    ),
  );
};

/**
 * Runs `issue-token` — looks up the user by id or appleUserId, signs a JWT,
 * and prints a JSON payload with the token and the resolved user id.
 */
const runIssueToken = async (
  app: INestApplicationContext,
  flags: Record<string, string>,
): Promise<void> => {
  const userDatabaseService = app.get(UserDatabaseService);
  const authService = app.get(AuthService);

  const user = flags.userId
    ? await userDatabaseService.findOneBy({ id: flags.userId })
    : flags.appleUserId
      ? await userDatabaseService.findByAppleUserId(flags.appleUserId)
      : null;

  if (!flags.userId && !flags.appleUserId) {
    logger.error('issue-token: one of --userId or --appleUserId is required');
    process.exitCode = 1;

    return;
  }

  if (!user) {
    logger.error('issue-token: user not found');
    process.exitCode = 1;

    return;
  }

  const accessToken = await authService.issueTokenForUser(user);

  console.log(
    JSON.stringify(
      {
        userId: user.id,
        appleUserId: user.appleUserId,
        accessToken,
      },
      null,
      2,
    ),
  );
};

/**
 * Entry point. Boots a Nest application context (no HTTP server), dispatches
 * the requested subcommand, and cleanly tears the context down on exit.
 */
const bootstrap = async () => {
  const [, , rawCommand, ...rest] = process.argv;
  const command = (rawCommand ?? 'help') as Command;

  if (command === 'help' || command === ('-h' as Command) || command === ('--help' as Command)) {
    printHelp();

    return;
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const flags = parseFlags(rest);

  try {
    switch (command) {
      case 'create-user':
        await runCreateUser(app, flags);
        break;
      case 'issue-token':
        await runIssueToken(app, flags);
        break;
      default:
        logger.error(`Unknown command: ${command}`);
        printHelp();
        process.exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Command failed: ${message}`);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
};

void bootstrap();
