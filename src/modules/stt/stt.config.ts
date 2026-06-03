import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import { SttProvider } from './stt.types';

const DEFAULT_MODEL = 'gpt-4o-mini-transcribe';

/**
 * Zod schema for the STT-related env vars. Kept local to this module — the
 * global env schema in `src/config/env.config.ts` is owned by the wiring task
 * and must not be touched here; these keys still need registering there. The
 * defaults mirror the task spec.
 */
const sttConfigSchema = z.object({
  provider: z.nativeEnum(SttProvider).default(SttProvider.OPENAI),
  openAiApiKey: z.string().min(1, 'OPENAI_API_KEY is required'),
  model: z.string().min(1).default(DEFAULT_MODEL),
  translateToEnglish: z.boolean().default(false),
});

/**
 * Validated, typed STT configuration sourced from the environment.
 */
export type SttConfig = z.infer<typeof sttConfigSchema>;

/**
 * Coerces a string-ish env value into a boolean, treating only the literal
 * string `'true'` (case-insensitive) and a real boolean `true` as true.
 */
const toBoolean = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';

  return false;
};

/**
 * Reads and validates STT configuration from `ConfigService`, failing fast at
 * construction time (i.e. at app startup) on a missing key or an invalid
 * provider — so misconfiguration surfaces at boot, not at the first voice note.
 */
@Injectable()
export class SttConfigProvider {
  private readonly config: SttConfig;

  constructor(private readonly configService: ConfigService) {
    this.config = this.load();
  }

  /**
   * Pulls the raw env values via `ConfigService` and validates them with Zod,
   * throwing a descriptive error if validation fails.
   */
  private load(): SttConfig {
    const parsed = sttConfigSchema.safeParse({
      provider: this.configService.get<string>('STT_PROVIDER'),
      openAiApiKey: this.configService.get<string>('OPENAI_API_KEY'),
      model: this.configService.get<string>('STT_MODEL'),
      translateToEnglish: toBoolean(
        this.configService.get<string>('STT_TRANSLATE_TO_ENGLISH'),
      ),
    });

    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join(', ');

      throw new Error(`Invalid STT configuration: ${issues}`);
    }

    return parsed.data;
  }

  /** The validated STT configuration. */
  get values(): SttConfig {
    return this.config;
  }
}
