import { buildStopSummary } from './stop-summary';
import { ToolRoundAuditPayload, ToolStepRecord } from '../assistant.types';

/** Builds one audit round wrapping the given steps (the only field the summary reads). */
const round = (steps: ToolStepRecord[]): ToolRoundAuditPayload => ({
  correlationId: 'cid',
  round: 0,
  stopReason: 'tool_use',
  assistantText: null,
  steps,
});

/** Builds a committed (non-error, non-held) tool step. */
const step = (
  name: string,
  input: Record<string, unknown> = {},
  over: Partial<ToolStepRecord> = {},
): ToolStepRecord => ({
  name,
  input,
  resultContent: 'ok',
  isError: false,
  held: false,
  ...over,
});

describe('buildStopSummary (programmatic STOP reply, no AI)', () => {
  it('returns the honest nothing-changed line when no write committed', () => {
    const summary = buildStopSummary([round([step('list_tasks')])], 0);

    expect(summary).toBe('Stopped — nothing was changed.');
  });

  it('lists a single committed write with its title', () => {
    const summary = buildStopSummary(
      [round([step('create_task', { title: 'Dentist' })])],
      1,
    );

    expect(summary).toBe('Stopped. Before stopping I created "Dentist".');
  });

  it('lists multiple committed writes across rounds in arrival order with natural joining', () => {
    const summary = buildStopSummary(
      [
        round([
          step('create_task', { title: 'Dentist' }),
          step('delete_task', { title: 'Standup' }),
        ]),
        round([step('complete_task', { title: 'Gym' })]),
      ],
      3,
    );

    expect(summary).toBe(
      'Stopped. Before stopping I created "Dentist", deleted "Standup" and completed "Gym".',
    );
  });

  it('EXCLUDES errored and held write steps from the committed list', () => {
    const summary = buildStopSummary(
      [
        round([
          step('create_task', { title: 'Good' }),
          step('create_task', { title: 'Bad' }, { isError: true }),
          step('create_task', { title: 'Held' }, { held: true }),
        ]),
      ],
      1,
    );

    // Only the genuinely-committed write is named.
    expect(summary).toBe('Stopped. Before stopping I created "Good".');
    expect(summary).not.toMatch(/Bad|Held/);
  });

  it('EXCLUDES non-write (read) steps from the committed list', () => {
    const summary = buildStopSummary(
      [
        round([
          step('list_tasks'),
          step('find_free_slots'),
          step('update_task', { title: 'Lesson' }),
        ]),
      ],
      1,
    );

    expect(summary).toBe('Stopped. Before stopping I updated "Lesson".');
  });

  it('falls back to a generic phrase when a committed write carries no title', () => {
    const summary = buildStopSummary([round([step('complete_task')])], 1);

    expect(summary).toBe('Stopped. Before stopping I marked an event done.');
  });

  it('counts create_group as a committed write in the summary', () => {
    const summary = buildStopSummary(
      [round([step('create_group', { title: 'Driving Lessons' })])],
      1,
    );

    expect(summary).toBe(
      'Stopped. Before stopping I created the group "Driving Lessons".',
    );
  });

  it('treats a zero committedWrites counter as nothing-done even if a step looks committed', () => {
    // Defensive: the loop counter is the gate alongside the ledger.
    const summary = buildStopSummary(
      [round([step('create_task', { title: 'X' })])],
      0,
    );

    expect(summary).toBe('Stopped — nothing was changed.');
  });
});
