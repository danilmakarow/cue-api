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
  const personaPromptDatabaseService = {
    findActivePersonaText: jest.fn().mockResolvedValue(null),
  };
  const scheduleReader = {
    occurrencesInRange: jest.fn().mockResolvedValue([]),
  };
  const taskGroupService = {
    findAllForUser: jest.fn().mockResolvedValue([]),
  };
  const lastButtonStore = {
    takeLatest: jest.fn().mockResolvedValue(null),
  };

  const service = new ContextBuilderService(
    config as never,
    conversationMessageDatabaseService as never,
    conversationSummaryDatabaseService as never,
    userMemoryFactDatabaseService as never,
    personaPromptDatabaseService as never,
    scheduleReader as never,
    taskGroupService as never,
    lastButtonStore as never,
  );

  return {
    service,
    scheduleReader,
    taskGroupService,
    userMemoryFactDatabaseService,
    personaPromptDatabaseService,
    lastButtonStore,
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

  it('injects the per-user persona BETWEEN profile/groups and the summary, with NO cacheBoundary of its own (Story 18 / ADR 0014)', async () => {
    const harness = buildHarness();

    harness.taskGroupService.findAllForUser.mockResolvedValue([
      { name: 'Work' } as TaskGroup,
    ]);
    harness.personaPromptDatabaseService.findActivePersonaText.mockResolvedValue(
      'Persona: a brisk pirate quartermaster.',
    );

    const prompt = await harness.service.build({
      user: USER,
      conversationId: 'conv-1',
      currentMessageText: 'hi',
      handleMap: new HandleMap(),
    });

    const personaIndex = prompt.system.findIndex((block) =>
      block.content.includes('brisk pirate quartermaster'),
    );
    const profileIndex = prompt.system.findIndex((block) =>
      block.content.startsWith('User profile:'),
    );
    const groupsIndex = prompt.system.findIndex((block) =>
      block.content.includes('Groups:'),
    );
    const summaryBoundaryIndex = prompt.system.reduce(
      (acc, block, index) => (block.cacheBoundary ? index : acc),
      -1,
    );

    // The persona block exists, sits AFTER profile and groups …
    expect(personaIndex).toBeGreaterThan(profileIndex);
    expect(personaIndex).toBeGreaterThan(groupsIndex);
    // … and BEFORE breakpoint #2 (the summary block) — inside the per-user region.
    expect(personaIndex).toBeLessThan(summaryBoundaryIndex);
    // The persona block carries NO breakpoint of its own (region closed by #2).
    expect(prompt.system[personaIndex].cacheBoundary).toBeUndefined();
    // It is resolved for THIS user.
    expect(
      harness.personaPromptDatabaseService.findActivePersonaText,
    ).toHaveBeenCalledWith('user-1');
  });

  it('falls back to the default Jarvis persona block when the user has set none (and the seed is absent)', async () => {
    const harness = buildHarness();

    // findActivePersonaText defaults to null in the harness (no custom, no seed).
    const prompt = await harness.service.build({
      user: USER,
      conversationId: 'conv-1',
      currentMessageText: 'hi',
      handleMap: new HandleMap(),
    });

    // The persona block is always present and carries the Jarvis default text.
    expect(systemText(prompt.system)).toContain('J.A.R.V.I.S.');
    expect(systemText(prompt.system)).toContain('Adopt this assistant persona');
  });

  it('keeps breakpoint #1 (shared system + tools prefix) BYTE-IDENTICAL across two DIFFERENT users while only the per-user region differs — the persona never leaks into the cross-user cached prefix (Story 18 / ADR 0014 + ADR 0004)', async () => {
    // Tools precede `system` in the provider prefix, so block 1 (the system
    // prompt up to and including breakpoint #1) is THE cross-user cached prefix.
    // Two users with DIFFERENT personas must share a byte-identical block 1; only
    // the per-user region (below #1, closed by #2) may diverge.
    const userA = {
      id: 'user-A',
      timezone: 'UTC',
      displayName: 'Tony',
    } as User;
    const userB = {
      id: 'user-B',
      timezone: 'UTC',
      displayName: 'Pepper',
    } as User;

    const harnessA = buildHarness();
    const harnessB = buildHarness();

    harnessA.personaPromptDatabaseService.findActivePersonaText.mockResolvedValue(
      'Persona: a dry English butler.',
    );
    harnessB.personaPromptDatabaseService.findActivePersonaText.mockResolvedValue(
      'Persona: an upbeat surf instructor.',
    );

    const promptA = await harnessA.service.build({
      user: userA,
      conversationId: 'conv-A',
      currentMessageText: 'hello',
      handleMap: new HandleMap(),
    });
    const promptB = await harnessB.service.build({
      user: userB,
      conversationId: 'conv-B',
      currentMessageText: 'hello',
      handleMap: new HandleMap(),
    });

    // Block 1 is everything up to AND including the first cacheBoundary (#1).
    const breakpointOnePrefix = (system: PromptBlock[]): PromptBlock[] => {
      const firstBoundary = system.findIndex((block) => block.cacheBoundary);

      return system.slice(0, firstBoundary + 1);
    };

    const prefixA = breakpointOnePrefix(promptA.system);
    const prefixB = breakpointOnePrefix(promptB.system);

    // The shared system+tools prefix is byte-identical, cacheBoundary flag and all.
    expect(prefixB).toEqual(prefixA);

    // Neither user's persona leaked into that cross-user cached prefix.
    const prefixTextA = prefixA.map((block) => block.content).join('\n');

    expect(prefixTextA).not.toContain('English butler');
    expect(prefixTextA).not.toContain('surf instructor');
    // … yet the per-user regions DO diverge: each persona lands below #1.
    expect(systemText(promptA.system)).toContain('English butler');
    expect(systemText(promptB.system)).toContain('surf instructor');
    expect(promptA.system).not.toEqual(promptB.system);
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

  it('injects the latest reply-keyboard button result into the VOLATILE tail, never a cached prefix block (Story 16 / ADR 0045)', async () => {
    const harness = buildHarness();

    harness.lastButtonStore.takeLatest.mockResolvedValue(
      "Showed today's schedule.",
    );

    const prompt = await harness.service.build({
      user: USER,
      conversationId: 'conv-1',
      currentMessageText: 'what about tomorrow?',
      handleMap: new HandleMap(),
    });

    // The line lands in the final (volatile) message block …
    expect(finalUserContent(prompt.messages)).toContain(
      "Showed today's schedule.",
    );
    // … and is read-then-cleared exactly once for THIS user (one-shot nudge).
    expect(harness.lastButtonStore.takeLatest).toHaveBeenCalledWith('user-1');
    expect(harness.lastButtonStore.takeLatest).toHaveBeenCalledTimes(1);
    // It NEVER appears in any cached-prefix (system) block — the persona/profile/
    // groups/summary blocks must stay byte-stable for ADR 0004 cache hits.
    expect(systemText(prompt.system)).not.toContain("Showed today's schedule.");
  });

  it('omits the latest-button line entirely when none is pending', async () => {
    const harness = buildHarness();

    // takeLatest defaults to null in the harness.
    const prompt = await harness.service.build({
      user: USER,
      conversationId: 'conv-1',
      currentMessageText: 'hi',
      handleMap: new HandleMap(),
    });

    expect(finalUserContent(prompt.messages)).not.toContain('Recent action');
  });

  it('keeps the cached prefix (system blocks) byte-IDENTICAL whether or not a latest-button line is present (ADR 0004 cache stability)', async () => {
    // Build once with NO pending button, once WITH one. The two volatile tails
    // differ, but the system blocks (tools precede system in the provider prefix,
    // so these ARE the cached region down to breakpoint #2) must be byte-for-byte
    // identical — otherwise the latest-button injection would defeat the cache.
    const withoutButton = buildHarness();
    const withButton = buildHarness();

    withButton.lastButtonStore.takeLatest.mockResolvedValue('Opened Settings.');

    const baseInput = {
      user: USER,
      conversationId: 'conv-1',
      currentMessageText: 'hello',
    };

    const promptA = await withoutButton.service.build({
      ...baseInput,
      handleMap: new HandleMap(),
    });
    const promptB = await withButton.service.build({
      ...baseInput,
      handleMap: new HandleMap(),
    });

    // The volatile tails diverge (the button line only in B) …
    expect(finalUserContent(promptB.messages)).toContain('Opened Settings.');
    expect(finalUserContent(promptA.messages)).not.toContain(
      'Opened Settings.',
    );
    // … but the cached prefix is byte-identical, including every cacheBoundary flag.
    expect(promptB.system).toEqual(promptA.system);
  });

  it('still injects the latest-button line even when the agenda is empty (volatile-only, prefix untouched)', async () => {
    const harness = buildHarness();

    harness.lastButtonStore.takeLatest.mockResolvedValue(
      'Disconnected Telegram.',
    );

    const prompt = await harness.service.build({
      user: USER,
      conversationId: 'conv-1',
      currentMessageText: 'are you there?',
      handleMap: new HandleMap(),
    });

    expect(finalUserContent(prompt.messages)).toContain(
      'Disconnected Telegram.',
    );
    expect(systemText(prompt.system)).not.toContain('Disconnected Telegram.');
  });
});
