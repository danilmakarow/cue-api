import { DateTime } from 'luxon';

import { ContextBuilderService } from './context-builder.service';
import { HandleMap } from './tools/handle-map';
import { PromptBlock } from '@/modules/ai/ai.types';
import {
  ConflictPolicy,
  Task,
  TaskGroup,
  User,
} from '@/modules/database/entities';
import { Occurrence } from '@/modules/recurrence-rule/recurrence.types';

const USER = { id: 'user-1', timezone: 'UTC', displayName: 'Tony' } as User;

/** Tomorrow at the given UTC hour, well inside the preload horizon. */
const horizonDate = (hour: number): Date =>
  DateTime.now()
    .setZone('UTC')
    .startOf('day')
    .plus({ days: 1, hours: hour })
    .toJSDate();

/** Builds a minimal one-off timed occurrence. */
const oneOffOccurrence = (
  taskId: string,
  title: string,
  start: Date,
): Occurrence => ({
  task: { id: taskId, isAllDay: false } as Task,
  originalStart: start,
  occurrenceStart: start,
  occurrenceEnd: null,
  title,
  completedAt: null,
  isRecurring: false,
  isException: false,
});

/** Builds a minimal recurring occurrence (carries its instance originalStart). */
const recurringOccurrence = (
  taskId: string,
  title: string,
  start: Date,
): Occurrence => ({
  task: { id: taskId, isAllDay: false } as Task,
  originalStart: start,
  occurrenceStart: start,
  occurrenceEnd: null,
  title,
  completedAt: null,
  isRecurring: true,
  isException: false,
});

/**
 * Assembles a ContextBuilderService with jest mocks for every collaborator,
 * exposing the schedule-reader + task-group mocks so tests can program the
 * agenda and groups. Defaults are an empty conversation with no facts/summary.
 */
const buildHarness = () => {
  const config = { preloadHorizonDays: 7, recentWindowSize: 10 };
  const conversationMessageDatabaseService = {
    findRecentWindow: jest.fn().mockResolvedValue([]),
  };
  const conversationSummaryDatabaseService = {
    findLatest: jest.fn().mockResolvedValue(null),
  };
  const userMemoryFactDatabaseService = {
    findAllByUserId: jest.fn().mockResolvedValue([]),
    findConflictPolicy: jest.fn().mockResolvedValue(null),
  };
  const scheduleReader = {
    occurrencesInRange: jest.fn().mockResolvedValue([]),
  };
  const taskGroupService = {
    findAllForUser: jest.fn().mockResolvedValue([]),
  };

  const service = new ContextBuilderService(
    config as never,
    conversationMessageDatabaseService as never,
    conversationSummaryDatabaseService as never,
    userMemoryFactDatabaseService as never,
    scheduleReader as never,
    taskGroupService as never,
  );

  return {
    service,
    scheduleReader,
    taskGroupService,
    userMemoryFactDatabaseService,
  };
};

/** Joins every system block's content into one searchable string. */
const systemText = (system: PromptBlock[]): string =>
  system.map((block) => block.content).join('\n');

/** The final (volatile) message block content — agenda + new message live here. */
const finalUserContent = (messages: PromptBlock[]): string =>
  messages[messages.length - 1].content;

describe('ContextBuilderService', () => {
  it('renders the preloaded agenda as [eN] occurrence lines and seeds the passed HandleMap', async () => {
    const harness = buildHarness();
    const handleMap = new HandleMap();
    const standupStart = horizonDate(9);
    const dentistStart = horizonDate(14);

    harness.scheduleReader.occurrencesInRange.mockResolvedValue([
      recurringOccurrence('task-standup', 'Standup', standupStart),
      oneOffOccurrence('task-dentist', 'Dentist', dentistStart),
    ]);

    const prompt = await harness.service.build({
      user: USER,
      conversationId: 'conv-1',
      currentMessageText: "what's on?",
      handleMap,
    });

    const volatile = finalUserContent(prompt.messages);

    // Both occurrences are rendered with sequential bracketed handles.
    expect(volatile).toContain('[e1]');
    expect(volatile).toContain('Standup');
    expect(volatile).toContain('[e2]');
    expect(volatile).toContain('Dentist');

    // The SAME map the builder was given now resolves those handles to the
    // right (taskId, originalStart) coordinate — recurring keeps its start.
    expect(handleMap.resolve('e1')).toEqual({
      taskId: 'task-standup',
      originalStart: standupStart,
    });
    expect(handleMap.resolve('e2')).toEqual({
      taskId: 'task-dentist',
      originalStart: dentistStart,
    });
  });

  it('seeds query-aware date-slice occurrences into the same HandleMap, counting up from the agenda', async () => {
    const harness = buildHarness();
    const handleMap = new HandleMap();
    const agendaStart = horizonDate(9);
    // A date far beyond the preload horizon so the query-aware slice fetches it.
    const referenced = DateTime.now()
      .setZone('UTC')
      .startOf('day')
      .plus({ days: 30 });
    const referencedIso = referenced.toFormat('yyyy-LL-dd');
    const sliceStart = referenced.plus({ hours: 11 }).toJSDate();

    harness.scheduleReader.occurrencesInRange
      .mockResolvedValueOnce([
        oneOffOccurrence('task-agenda', 'Morning sync', agendaStart),
      ])
      .mockResolvedValueOnce([
        oneOffOccurrence('task-slice', 'Quarterly review', sliceStart),
      ]);

    const prompt = await harness.service.build({
      user: USER,
      conversationId: 'conv-1',
      currentMessageText: `anything on ${referencedIso}?`,
      handleMap,
    });

    const volatile = finalUserContent(prompt.messages);

    expect(volatile).toContain('Referenced dates:');
    expect(volatile).toContain(referencedIso);
    expect(volatile).toContain('[e2] ');
    expect(volatile).toContain('Quarterly review');

    // Agenda seeded e1; the slice appended e2 on the same map (no collision).
    expect(handleMap.resolve('e1')).toMatchObject({ taskId: 'task-agenda' });
    expect(handleMap.resolve('e2')).toMatchObject({ taskId: 'task-slice' });
  });

  it('renders the groups line by name in the per-user stable region', async () => {
    const harness = buildHarness();

    harness.taskGroupService.findAllForUser.mockResolvedValue([
      { name: 'Work' } as TaskGroup,
      { name: 'Home' } as TaskGroup,
      { name: 'Fitness' } as TaskGroup,
    ]);

    const prompt = await harness.service.build({
      user: USER,
      conversationId: 'conv-1',
      currentMessageText: 'hi',
      handleMap: new HandleMap(),
    });

    // The groups line is a system (stable) block, never the volatile message.
    expect(systemText(prompt.system)).toContain('Groups: Work, Home, Fitness');
    expect(finalUserContent(prompt.messages)).not.toContain('Groups:');
  });

  it('omits the groups line entirely when the user has no groups', async () => {
    const harness = buildHarness();

    const prompt = await harness.service.build({
      user: USER,
      conversationId: 'conv-1',
      currentMessageText: 'hi',
      handleMap: new HandleMap(),
    });

    expect(systemText(prompt.system)).not.toContain('Groups:');
  });

  it('keeps both cache breakpoints in the system blocks with the groups line below #1', async () => {
    const harness = buildHarness();

    harness.taskGroupService.findAllForUser.mockResolvedValue([
      { name: 'Work' } as TaskGroup,
    ]);

    const prompt = await harness.service.build({
      user: USER,
      conversationId: 'conv-1',
      currentMessageText: 'hi',
      handleMap: new HandleMap(),
    });

    const boundaries = prompt.system.filter((block) => block.cacheBoundary);

    expect(boundaries).toHaveLength(2);

    const groupsIndex = prompt.system.findIndex((block) =>
      block.content.includes('Groups:'),
    );
    const lastBoundaryIndex = prompt.system.reduce(
      (acc, block, index) => (block.cacheBoundary ? index : acc),
      -1,
    );

    // Groups sit after breakpoint #1 (system prompt) and at/above breakpoint #2.
    expect(groupsIndex).toBeGreaterThan(0);
    expect(groupsIndex).toBeLessThan(lastBoundaryIndex);
  });

  it('surfaces a standing ALLOW conflict policy into the volatile block AND returns it on the prompt (ADR 0011 + 0044)', async () => {
    const harness = buildHarness();

    harness.userMemoryFactDatabaseService.findConflictPolicy.mockResolvedValue(
      ConflictPolicy.ALLOW,
    );

    const prompt = await harness.service.build({
      user: USER,
      conversationId: 'conv-1',
      currentMessageText: 'book dentist at 3:30',
      handleMap: new HandleMap(),
    });

    // The model sees the firm allow directive in the volatile now-context …
    expect(finalUserContent(prompt.messages)).toMatch(
      /Standing conflict policy: ALLOW/,
    );
    // … and the same value rides on the prompt for the dispatcher's gate.
    expect(prompt.conflictPolicy).toBe(ConflictPolicy.ALLOW);
  });

  it('surfaces a standing DENY conflict policy as a firm refuse directive', async () => {
    const harness = buildHarness();

    harness.userMemoryFactDatabaseService.findConflictPolicy.mockResolvedValue(
      ConflictPolicy.DENY,
    );

    const prompt = await harness.service.build({
      user: USER,
      conversationId: 'conv-1',
      currentMessageText: 'book dentist at 3:30',
      handleMap: new HandleMap(),
    });

    expect(finalUserContent(prompt.messages)).toMatch(
      /Standing conflict policy: DENY/,
    );
    expect(prompt.conflictPolicy).toBe(ConflictPolicy.DENY);
  });

  it('omits the conflict-policy line and returns null when no explicit policy is set (default-deny)', async () => {
    const harness = buildHarness();

    // findConflictPolicy defaults to null in the harness.
    const prompt = await harness.service.build({
      user: USER,
      conversationId: 'conv-1',
      currentMessageText: 'book dentist at 3:30',
      handleMap: new HandleMap(),
    });

    expect(finalUserContent(prompt.messages)).not.toMatch(
      /Standing conflict policy/,
    );
    expect(prompt.conflictPolicy).toBeNull();
  });
});
