import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AiModelRole, AiProvider } from './ai.types';

/**
 * Default per-call output ceiling when `ASSISTANT_MAX_OUTPUT_TOKENS` is unset and
 * a request omits `maxTokens`. Conservative — the assistant replies are short
 * (one or two sentences per the spec persona).
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

/**
 * Default transport retry count when `ASSISTANT_AI_MAX_RETRIES` is unset. The
 * Anthropic SDK retries connection errors / 408 / 409 / 429 / >=500 with
 * exponential backoff; this surfaces that knob so ops can tune it. Matches the
 * SDK's own default of 2.
 */
const DEFAULT_MAX_RETRIES = 2;

/**
 * Typed, validated configuration for the AI connector, sourced from the
 * Zod-validated env via `ConfigService` (ADR 0007). The env keys themselves are
 * registered in the global env schema by Task 3; this service only reads them,
 * fails fast on anything missing/invalid, and exposes a provider-neutral shape.
 *
 * Env keys consumed: `ASSISTANT_AI_PROVIDER`, `ANTHROPIC_API_KEY`,
 * `ASSISTANT_MODEL_MAIN`, `ASSISTANT_MODEL_BACKGROUND`,
 * `ASSISTANT_MAX_OUTPUT_TOKENS` (optional), `ASSISTANT_AI_MAX_RETRIES`
 * (optional).
 */
@Injectable()
export class AiConfig {
  private readonly provider: AiProvider;

  private readonly anthropicApiKey: string;

  private readonly modelMain: string;

  private readonly modelBackground: string;

  private readonly maxOutputTokens: number;

  private readonly maxRetries: number;

  constructor(private readonly configService: ConfigService) {
    this.provider = this.resolveProvider();
    this.anthropicApiKey = this.requireString('ANTHROPIC_API_KEY');
    this.modelMain = this.requireString('ASSISTANT_MODEL_MAIN');
    this.modelBackground = this.requireString('ASSISTANT_MODEL_BACKGROUND');
    this.maxOutputTokens = this.resolveMaxOutputTokens();
    this.maxRetries = this.resolveMaxRetries();
  }

  /**
   * Reads a required string env var, throwing at construction (startup) when it
   * is missing or blank so misconfiguration fails fast rather than at the first
   * model call.
   */
  private requireString(key: string): string {
    const value = this.configService.get<string>(key);

    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`AI connector misconfigured: ${key} is required`);
    }

    return value;
  }

  /**
   * Resolves and validates the active provider from `ASSISTANT_AI_PROVIDER`,
   * defaulting to Anthropic. Throws on an unrecognized value so a typo fails at
   * startup, not at request time.
   */
  private resolveProvider(): AiProvider {
    const raw = this.configService.get<string>('ASSISTANT_AI_PROVIDER');

    if (raw === undefined || raw === null || raw === '') {
      return AiProvider.ANTHROPIC;
    }

    const supportedProviders: string[] = Object.values(AiProvider);

    if (!supportedProviders.includes(raw)) {
      throw new Error(
        `AI connector misconfigured: unknown ASSISTANT_AI_PROVIDER "${raw}"`,
      );
    }

    return raw as AiProvider;
  }

  /**
   * Resolves the optional output-token ceiling, falling back to a safe default
   * and rejecting a non-positive override.
   */
  private resolveMaxOutputTokens(): number {
    const raw = this.configService.get<string | number>(
      'ASSISTANT_MAX_OUTPUT_TOKENS',
    );

    if (raw === undefined || raw === null || raw === '') {
      return DEFAULT_MAX_OUTPUT_TOKENS;
    }

    const parsed = typeof raw === 'number' ? raw : Number(raw);

    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(
        'AI connector misconfigured: ASSISTANT_MAX_OUTPUT_TOKENS must be a positive integer',
      );
    }

    return parsed;
  }

  /**
   * Resolves the optional transport retry count, falling back to the SDK-default
   * of 2 and rejecting a negative or non-integer override. Zero is allowed (it
   * disables SDK retries).
   */
  private resolveMaxRetries(): number {
    const raw = this.configService.get<string | number>(
      'ASSISTANT_AI_MAX_RETRIES',
    );

    if (raw === undefined || raw === null || raw === '') {
      return DEFAULT_MAX_RETRIES;
    }

    const parsed = typeof raw === 'number' ? raw : Number(raw);

    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(
        'AI connector misconfigured: ASSISTANT_AI_MAX_RETRIES must be a non-negative integer',
      );
    }

    return parsed;
  }

  /**
   * The configured active provider.
   */
  getProvider(): AiProvider {
    return this.provider;
  }

  /**
   * The Anthropic API key.
   */
  getAnthropicApiKey(): string {
    return this.anthropicApiKey;
  }

  /**
   * Maps a logical model role to its configured concrete model id (ADR 0003).
   * No model string is hardcoded — both come from env.
   */
  getModelId(role: AiModelRole): string {
    if (role === AiModelRole.MAIN) {
      return this.modelMain;
    }

    return this.modelBackground;
  }

  /**
   * The default per-call output-token ceiling.
   */
  getMaxOutputTokens(): number {
    return this.maxOutputTokens;
  }

  /**
   * The transport retry count passed to the provider SDK client. The SDK applies
   * exponential backoff on retryable failures; terminal errors propagate.
   */
  getMaxRetries(): number {
    return this.maxRetries;
  }
}
