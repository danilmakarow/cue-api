import { KeyboardActionService } from './keyboard-action.service';
import { LinkingService } from '../linking.service';
import { ASCII_CALENDAR_MAX_WIDTH } from '../reply/ascii-calendar';
import {
  KEYBOARD_LABELS,
  KeyboardAction,
  KeyboardSurface,
} from '../reply/reply-keyboard.layout';
import { ReplyPresenter } from '../reply/reply-presenter.service';
import { ScheduleReaderService } from '../schedule-reader.service';
import { ActiveKeyboardStore } from '../session/active-keyboard.store';
import { LastButtonStore } from '../session/last-button.store';
import { Task, User } from '@/modules/database/entities';
import {
  OutboundFormat,
  ReplyKeyboard,
} from '@/modules/external-vendor/external-vendor.types';
import { Occurrence } from '@/modules/recurrence-rule/recurrence.types';

const USER = { id: 'user-1', timezone: 'UTC' } as User;
const CHAT_ID = 'chat-1';
const CID = 'cid-1';

/** Builds a minimal timed occurrence at the given absolute instant. */
const timedOccurrence = (title: string, start: Date): Occurrence => ({
  task: { id: title, isAllDay: false } as Task,
  originalStart: start,
  occurrenceStart: start,
  occurrenceEnd: null,
  title,
  completedAt: null,
  isRecurring: false,
  isException: false,
});

/**
 * Assembles a KeyboardActionService with jest mocks for every collaborator,
 * exposing each so tests can program reads and assert sends/writes.
 */
const buildHarness = () => {
  const scheduleReader = {
    occurrencesInRange: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<ScheduleReaderService>;
  const replyPresenter = {
    sendTextWithKeyboard: jest.fn().mockResolvedValue(undefined),
    sendTextRemovingKeyboard: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<ReplyPresenter>;
  const linkingService = {
    unlink: jest.fn().mockResolvedValue({ linked: false }),
  } as unknown as jest.Mocked<LinkingService>;
  const activeKeyboard = {
    setActiveSurface: jest.fn().mockResolvedValue(undefined),
    clear: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<ActiveKeyboardStore>;
  const lastButton = {
    record: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<LastButtonStore>;

  const service = new KeyboardActionService(
    scheduleReader,
    replyPresenter,
    linkingService,
    activeKeyboard,
    lastButton,
  );

  return {
    service,
    scheduleReader,
    replyPresenter,
    linkingService,
    activeKeyboard,
    lastButton,
  };
};

/** The text of the most recent sendTextWithKeyboard call. */
const lastKeyboardSend = (
  replyPresenter: jest.Mocked<ReplyPresenter>,
): { text: string; keyboard: ReplyKeyboard; format?: OutboundFormat } => {
  const calls = replyPresenter.sendTextWithKeyboard.mock.calls;
  const [, text, keyboard, format] = calls[calls.length - 1];

  return { text, keyboard, format };
};

describe('KeyboardActionService', () => {
  it("renders today's schedule from findOccurrencesInRange as a width-bounded ASCII calendar and records the button line", async () => {
    const harness = buildHarness();

    harness.scheduleReader.occurrencesInRange.mockResolvedValue([
      timedOccurrence('Standup', new Date('2026-06-21T09:00:00.000Z')),
    ]);

    await harness.service.handleKeyboardAction(USER, {
      action: KeyboardAction.TodaySchedule,
      vendorChatId: CHAT_ID,
      correlationId: CID,
    });

    // The schedule was read for a 1-day window (today → tomorrow) in the user tz.
    expect(harness.scheduleReader.occurrencesInRange).toHaveBeenCalledTimes(1);

    const send = lastKeyboardSend(harness.replyPresenter);

    // The calendar is sent as a Markdown code block, every line within budget.
    expect(send.format).toBe(OutboundFormat.Markdown);
    expect(send.text).toContain('Standup');

    for (const line of send.text.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(ASCII_CALENDAR_MAX_WIDTH + 6);
    }

    // The latest-button line is recorded for the next turn's volatile tail.
    expect(harness.lastButton.record).toHaveBeenCalledWith(
      'user-1',
      expect.stringContaining('today'),
    );
    // The main keyboard stays the active surface after a calendar render.
    expect(harness.activeKeyboard.setActiveSurface).toHaveBeenCalledWith(
      'user-1',
      KeyboardSurface.Main,
    );
  });

  it('renders the next 7-day window for Next week and records the button line', async () => {
    const harness = buildHarness();

    await harness.service.handleKeyboardAction(USER, {
      action: KeyboardAction.NextWeek,
      vendorChatId: CHAT_ID,
      correlationId: CID,
    });

    const [, from, to] =
      harness.scheduleReader.occurrencesInRange.mock.calls[0];
    const spanMs = to.getTime() - from.getTime();

    // 7 local days (allowing a DST hour either way around the boundary).
    expect(spanMs).toBeGreaterThanOrEqual(6 * 24 * 3600 * 1000);
    expect(spanMs).toBeLessThanOrEqual(8 * 24 * 3600 * 1000);
    expect(harness.lastButton.record).toHaveBeenCalledWith(
      'user-1',
      expect.stringContaining('week'),
    );
  });

  it('Settings swaps to the settings keyboard and marks it the active surface', async () => {
    const harness = buildHarness();

    await harness.service.handleKeyboardAction(USER, {
      action: KeyboardAction.OpenSettings,
      vendorChatId: CHAT_ID,
      correlationId: CID,
    });

    const send = lastKeyboardSend(harness.replyPresenter);
    const labels = send.keyboard.buttons.flat().map((button) => button.label);

    expect(labels).toEqual([KEYBOARD_LABELS.disconnect, KEYBOARD_LABELS.back]);
    expect(harness.activeKeyboard.setActiveSurface).toHaveBeenCalledWith(
      'user-1',
      KeyboardSurface.Settings,
    );
  });

  it('Back returns to the main keyboard and marks it the active surface', async () => {
    const harness = buildHarness();

    await harness.service.handleKeyboardAction(USER, {
      action: KeyboardAction.Back,
      vendorChatId: CHAT_ID,
      correlationId: CID,
    });

    const send = lastKeyboardSend(harness.replyPresenter);
    const labels = send.keyboard.buttons.flat().map((button) => button.label);

    expect(labels).toEqual([
      KEYBOARD_LABELS.todaySchedule,
      KEYBOARD_LABELS.nextWeek,
      KEYBOARD_LABELS.settings,
    ]);
    expect(harness.activeKeyboard.setActiveSurface).toHaveBeenLastCalledWith(
      'user-1',
      KeyboardSurface.Main,
    );
  });

  it('Disconnect unlinks via LinkingService, clears the active surface, and removes the keyboard', async () => {
    const harness = buildHarness();

    await harness.service.handleKeyboardAction(USER, {
      action: KeyboardAction.Disconnect,
      vendorChatId: CHAT_ID,
      correlationId: CID,
    });

    expect(harness.linkingService.unlink).toHaveBeenCalledWith('user-1');
    expect(harness.activeKeyboard.clear).toHaveBeenCalledWith('user-1');
    expect(
      harness.replyPresenter.sendTextRemovingKeyboard,
    ).toHaveBeenCalledTimes(1);
    // No keyboard is re-docked on disconnect.
    expect(harness.replyPresenter.sendTextWithKeyboard).not.toHaveBeenCalled();
  });

  it('showMainKeyboard docks the main keyboard and marks it the active surface (the /start + linking entry point)', async () => {
    const harness = buildHarness();

    await harness.service.showMainKeyboard(USER, CHAT_ID, 'Welcome.', CID);

    const send = lastKeyboardSend(harness.replyPresenter);
    const labels = send.keyboard.buttons.flat().map((button) => button.label);

    expect(send.text).toBe('Welcome.');
    expect(labels).toEqual([
      KEYBOARD_LABELS.todaySchedule,
      KEYBOARD_LABELS.nextWeek,
      KEYBOARD_LABELS.settings,
    ]);
    expect(harness.activeKeyboard.setActiveSurface).toHaveBeenCalledWith(
      'user-1',
      KeyboardSurface.Main,
    );
  });

  it('degrades never-throw: a schedule-read failure sends a friendly retry, never throws', async () => {
    const harness = buildHarness();

    harness.scheduleReader.occurrencesInRange.mockRejectedValue(
      new Error('db blip'),
    );

    await expect(
      harness.service.handleKeyboardAction(USER, {
        action: KeyboardAction.TodaySchedule,
        vendorChatId: CHAT_ID,
        correlationId: CID,
      }),
    ).resolves.toBeUndefined();

    const send = lastKeyboardSend(harness.replyPresenter);

    expect(send.text).toMatch(/try again/i);
    // No misleading success button line is recorded on the failure path.
    expect(harness.lastButton.record).not.toHaveBeenCalled();
  });
});
