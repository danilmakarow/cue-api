import { ReportGeneratorService } from './report-generator.service';
import {
  BRIEF_USER_PREFERENCES_HEADING,
  DAILY_REPORT_SYSTEM_PROMPT,
} from './report.prompts';
import {
  AiModelRole,
  AiStopReason,
  CompletionRequest,
  CompletionResult,
} from '@/modules/ai/ai.types';
import { User } from '@/modules/database/entities';
import { Occurrence } from '@/modules/recurrence-rule/recurrence.types';

/**
 * Builds a {@link ReportGeneratorService} with a mocked AI connector + task
 * service. The AI connector exposes `complete`, `completeStream`, and
 * `completeStructured` so the test can assert the generator uses ONLY `complete`
 * (one shot, no tool loop / no streaming). The `complete` mock is typed with the
 * real `(request: CompletionRequest) => Promise<CompletionResult>` signature so
 * `complete.mock.calls[0][0]` is the captured `CompletionRequest`, not an empty
 * tuple.
 */
const buildHarness = () => {
  const ai = {
    complete: jest.fn(
      async (_request: CompletionRequest): Promise<CompletionResult> => ({
        stopReason: AiStopReason.END_TURN,
        text: 'Good morning, Tony. You have a 10:00 dentist and a 14:00 sync.',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      }),
    ),
    completeStream: jest.fn(),
    completeStructured: jest.fn(),
  };

  const taskService = {
    findOccurrencesInRange: jest.fn(
      async (
        _userId: string,
        _from: Date,
        _to: Date,
      ): Promise<Occurrence[]> => [],
    ),
  };

  const userBriefSettingsDatabaseService = {
    findCustomPromptForUser: jest.fn(
      async (_userId: string): Promise<string | null> => null,
    ),
  };

  const service = new ReportGeneratorService(
    ai as never,
    taskService as never,
    userBriefSettingsDatabaseService as never,
  );

  return { service, ai, taskService, userBriefSettingsDatabaseService };
};

/** A timed occurrence at the given UTC instant with the given title + tz. */
const occurrence = (
  startIso: string,
  title: string,
  timezone: string,
): Occurrence =>
  ({
    task: { timezone } as never,
    originalStart: new Date(startIso),
    occurrenceStart: new Date(startIso),
    occurrenceEnd: null,
    title,
    completedAt: null,
    isRecurring: false,
    isException: false,
    parentTaskId: null,
    isDetached: false,
    recurrence: null,
  }) as Occurrence;

const user = (overrides: Partial<User> = {}): User =>
  ({
    id: 'user-1',
    timezone: 'Europe/Berlin',
    displayName: 'Tony',
    ...overrides,
  }) as User;

describe('ReportGeneratorService (Story 17 / ADR 0046)', () => {
  it('generates the report with a SINGLE complete() call — no tool loop / no streaming', async () => {
    const { service, ai } = buildHarness();

    const report = await service.generateForUser(user(), '2026-06-21', 'cid-1');

    expect(report).toContain('Good morning');
    expect(ai.complete).toHaveBeenCalledTimes(1);
    // One-shot: no streaming, no structured/tool dispatch.
    expect(ai.completeStream).not.toHaveBeenCalled();
    expect(ai.completeStructured).not.toHaveBeenCalled();

    const [request] = ai.complete.mock.calls[0];

    // MAIN model, no tools, no tool rounds — a plain completion.
    expect(request.modelRole).toBe(AiModelRole.MAIN);
    expect(request.tools).toBeUndefined();
    expect(request.toolRounds).toBeUndefined();
    expect(request.toolChoice).toBeUndefined();
  });

  it('queries the agenda for the user local day window and feeds it to the prompt', async () => {
    const { service, ai, taskService } = buildHarness();

    taskService.findOccurrencesInRange.mockResolvedValueOnce([
      occurrence('2026-06-21T08:00:00.000Z', 'Dentist', 'Europe/Berlin'),
    ]);

    await service.generateForUser(user(), '2026-06-21', 'cid-1');

    const [userId, from, to] = taskService.findOccurrencesInRange.mock.calls[0];

    expect(userId).toBe('user-1');
    // 2026-06-21 local day in Berlin (UTC+2) → [22:00Z prev day, 22:00Z this day).
    expect(from.toISOString()).toBe('2026-06-20T22:00:00.000Z');
    expect(to.toISOString()).toBe('2026-06-21T22:00:00.000Z');

    // The agenda line is rendered in the user's local time (10:00 Berlin).
    const [request] = ai.complete.mock.calls[0];
    const prompt = request.messages[0].content;

    expect(prompt).toContain('10:00 Dentist');
  });

  it('returns null (skip the send) when the model produces empty text', async () => {
    const { service, ai } = buildHarness();

    ai.complete.mockResolvedValueOnce({
      stopReason: AiStopReason.END_TURN,
      text: '   ',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    });

    const report = await service.generateForUser(user(), '2026-06-21', 'cid-1');

    expect(report).toBeNull();
  });

  it('uses the base system prompt verbatim when the user has no custom prompt', async () => {
    const { service, ai, userBriefSettingsDatabaseService } = buildHarness();

    userBriefSettingsDatabaseService.findCustomPromptForUser.mockResolvedValueOnce(
      null,
    );

    await service.generateForUser(user(), '2026-06-21', 'cid-1');

    const [request] = ai.complete.mock.calls[0];
    const systemPrompt = request.system![0].content;

    expect(systemPrompt).toBe(DAILY_REPORT_SYSTEM_PROMPT);
    expect(systemPrompt).not.toContain(BRIEF_USER_PREFERENCES_HEADING);
  });

  it('AUGMENTS (not replaces) the base prompt with the user custom prompt', async () => {
    const { service, ai, userBriefSettingsDatabaseService } = buildHarness();

    userBriefSettingsDatabaseService.findCustomPromptForUser.mockResolvedValueOnce(
      'Keep it very brief and mention the weather.',
    );

    await service.generateForUser(user(), '2026-06-21', 'cid-1');

    const [request] = ai.complete.mock.calls[0];
    const systemPrompt = request.system![0].content;

    // The base prompt is retained IN FULL — the custom text is appended, not
    // substituted.
    expect(systemPrompt).toContain(DAILY_REPORT_SYSTEM_PROMPT);
    expect(systemPrompt).toContain(BRIEF_USER_PREFERENCES_HEADING);
    expect(systemPrompt).toContain(
      'Keep it very brief and mention the weather.',
    );
    // Base structure/safety rules still present after augmentation.
    expect(systemPrompt).toContain('2–4 sentences');
    expect(systemPrompt).toContain('do not invent items');
  });

  it('treats a whitespace-only custom prompt as unset (base prompt unchanged)', async () => {
    const { service, ai, userBriefSettingsDatabaseService } = buildHarness();

    userBriefSettingsDatabaseService.findCustomPromptForUser.mockResolvedValueOnce(
      '   ',
    );

    await service.generateForUser(user(), '2026-06-21', 'cid-1');

    const [request] = ai.complete.mock.calls[0];
    const systemPrompt = request.system![0].content;

    expect(systemPrompt).toBe(DAILY_REPORT_SYSTEM_PROMPT);
  });
});
