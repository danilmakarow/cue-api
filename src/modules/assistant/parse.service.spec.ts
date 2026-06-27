import { ParseService } from './parse.service';
import {
  RecurrenceFrequency,
  TaskGroup,
  User,
} from '@/modules/database/entities';

/** A user fixed to a known timezone so the resolved "now" line is deterministic. */
const USER = { id: 'user-1', timezone: 'Europe/Berlin' } as User;

/**
 * Assembles a {@link ParseService} over a mock AI connector (whose
 * `completeStructured` returns a programmed draft, standing in for the model
 * call) and a mock task-group service. Exposes the mocks so each test programs
 * the model output and the user's groups, then asserts the mapped draft.
 */
const buildHarness = (over: { groups?: TaskGroup[] } = {}) => {
  const ai = {
    completeStructured: jest.fn(),
  };
  const groups = over.groups ?? [];
  const taskGroupService = {
    findAllForUser: jest.fn(async () => groups),
    findByName: jest.fn(async (_userId: string, name: string) =>
      groups.filter((group) => group.name === name),
    ),
  };

  const service = new ParseService(ai as never, taskGroupService as never);

  return { service, ai, taskGroupService };
};

/** Builds a group fixture with a stable id + name. */
const buildGroup = (id: string, name: string): TaskGroup =>
  ({ id, name }) as TaskGroup;

describe('ParseService (D4 natural-language parse)', () => {
  it('passes the user now + timezone + group names into the parse prompt and the text as the user message', async () => {
    const harness = buildHarness({
      groups: [buildGroup('g-1', 'Work'), buildGroup('g-2', 'Health')],
    });

    harness.ai.completeStructured.mockResolvedValue({ title: 'standup' });

    await harness.service.parse(USER, 'standup');

    const [request] = harness.ai.completeStructured.mock.calls[0];
    const systemText = request.system[0].content;

    expect(systemText).toContain('Europe/Berlin');
    expect(systemText).toContain('Work, Health');
    expect(request.messages[0].content).toBe('standup');
  });

  it('returns a bare title-only draft for a timeless todo (no time / duration / recurrence / group)', async () => {
    const harness = buildHarness();

    harness.ai.completeStructured.mockResolvedValue({ title: 'call the bank' });

    const draft = await harness.service.parse(USER, 'call the bank');

    expect(draft).toEqual({ title: 'call the bank' });
  });

  it('carries through start, durationMinutes, and recurrence when the model populated them', async () => {
    const harness = buildHarness();

    harness.ai.completeStructured.mockResolvedValue({
      title: 'gym',
      start: '2026-06-29T07:00:00.000+02:00',
      durationMinutes: 60,
      recurrence: {
        frequency: RecurrenceFrequency.WEEKLY,
        byWeekday: [0, 2],
      },
    });

    const draft = await harness.service.parse(
      USER,
      'gym mon & wed 7am for an hour',
    );

    expect(draft.start).toBe('2026-06-29T07:00:00.000+02:00');
    expect(draft.durationMinutes).toBe(60);
    expect(draft.recurrence).toEqual({
      frequency: RecurrenceFrequency.WEEKLY,
      byWeekday: [0, 2],
    });
  });

  it('resolves a matched group NAME to an existing group id', async () => {
    const harness = buildHarness({ groups: [buildGroup('g-7', 'Health')] });

    harness.ai.completeStructured.mockResolvedValue({
      title: 'dentist',
      groupName: 'Health',
    });

    const draft = await harness.service.parse(USER, 'dentist');

    expect(draft.groupId).toBe('g-7');
    // The resolved group name itself is never echoed back — only its id.
    expect('groupName' in draft).toBe(false);
  });

  it('drops a group name that matches no existing group (never creates one)', async () => {
    const harness = buildHarness({ groups: [buildGroup('g-7', 'Health')] });

    harness.ai.completeStructured.mockResolvedValue({
      title: 'dentist',
      groupName: 'Errands',
    });

    const draft = await harness.service.parse(USER, 'dentist');

    expect(draft.groupId).toBeUndefined();
  });

  it('never creates a task — only the model extractor call is made, no write path', async () => {
    const harness = buildHarness();

    harness.ai.completeStructured.mockResolvedValue({ title: 'lunch' });

    await harness.service.parse(USER, 'lunch');

    // The single connector touch is the structured extractor; there is no
    // complete/completeStream tool-loop call on this path.
    expect(harness.ai.completeStructured).toHaveBeenCalledTimes(1);
  });
});
