import 'reflect-metadata';

import { loadE2eEnv } from './load-env';

// Populate process.env from .env.test BEFORE any test file imports AppModule
// (and thus @nestjs/config), so the e2e config wins over the committed .env.
// This runs in `setupFiles`, which jest executes before the test module graph
// is evaluated — i.e. before harness.ts's top-level `import { AppModule }`.
loadE2eEnv();
