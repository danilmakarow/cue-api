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
import { LastMenuStore } from '../session/last-menu.store';
import { Task, User } from '@/modules/database/entities';
import {
  OutboundFormat,
  ReplyKeyboard,
} from '@/modules/external-vendor/external-vendor.types';
import { Occurrence } from '@/modules/recurrence-rule/recurrence.types';

const USER = {
  id: 'user-1',
  timezone: 'UTC',
  displayName: 'Jane Appleseed',
  email: 'jane@example.com',
} as User;
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
    parentTaskId: null,
    isDetached: false,
  recurrence: null,
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
    // Returns a fresh vendor message id so the menu dedup-delete path is exercised
    // (R4 / ADR 0056) — the handler captures this id, records it, and deletes the
    // prior one.
    sendTextWithKeyboard: jest.fn().mockResolvedValue('menu-msg-new'),
    sendTextRemovingKeyboard: jest.fn().mockResolvedValue(undefined),
    deleteMessageQuietly: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<ReplyPresenter>;
  const linkingService = {
    unlink: jest.fn().mockResolvedValue({ linked: false }),
    getStatus: jest.fn().mockResolvedValue({
      linked: true,
      telegramUsername: 'jane_tg',
      linkedAt: '2026-06-24T00:00:00.000Z',
    }),
  } as unknown as jest.Mocked<LinkingService>;
  const activeKeyboard = {
    setActiveSurface: jest.fn().mockResolvedValue(undefined),
    clear: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<ActiveKeyboardStore>;
  const lastButton = {
    record: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<LastButtonStore>;
  const lastMenu = {
    record: jest.fn().mockResolvedValue(undefined),
    take: jest.fn().mockResolvedValue(null),
    clear: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<LastMenuStore>;

  const service = new KeyboardActionService(
    scheduleReader,
    replyPresenter,
    linkingService,
    activeKeyboard,
    lastButton,
    lastMenu,
  );

  return {
    service,
    scheduleReader,
    replyPresenter,
    linkingService,
    activeKeyboard,
    lastButton,
    lastMenu,
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

    // Pin the occurrence to TODAY at 09:00 UTC: the renderer only shows the
    // current day's window (in the user tz), so a hardcoded calendar date makes
    // the test pass only on that day. Deriving it from "now" keeps it green every
    // day instead of silently breaking the deploy gate once the date moves on.
    const todayAtNine = new Date();

    todayAtNine.setUTCHours(9, 0, 0, 0);
    harness.scheduleReader.occurrencesInRange.mockResolvedValue([
      timedOccurrence('Standup', todayAtNine),
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
      KEYBOARD_LABELS.openMenu,
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
      KEYBOARD_LABELS.openMenu,
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

  // --- R4 / ADR 0056: the persistent Menu surface ---

  it('Open Menu sends the MENU keyboard, marks Menu the active surface, and records the new card id', async () => {
    const harness = buildHarness();

    await harness.service.handleKeyboardAction(USER, {
      action: KeyboardAction.OpenMenu,
      vendorChatId: CHAT_ID,
      correlationId: CID,
    });

    const send = lastKeyboardSend(harness.replyPresenter);
    const labels = send.keyboard.buttons.flat().map((button) => button.label);

    expect(labels).toEqual([
      KEYBOARD_LABELS.settings,
      KEYBOARD_LABELS.logout,
      KEYBOARD_LABELS.back,
    ]);
    expect(harness.activeKeyboard.setActiveSurface).toHaveBeenCalledWith(
      'user-1',
      KeyboardSurface.Menu,
    );
    // The freshly-sent card id is tracked for the next open's dedup-delete.
    expect(harness.lastMenu.record).toHaveBeenCalledWith(
      'user-1',
      'menu-msg-new',
    );
  });

  it('Open Menu renders a 🟢 Connected card with the account lines when the link is present', async () => {
    const harness = buildHarness();

    await harness.service.handleKeyboardAction(USER, {
      action: KeyboardAction.OpenMenu,
      vendorChatId: CHAT_ID,
      correlationId: CID,
    });

    const send = lastKeyboardSend(harness.replyPresenter);

    expect(send.text).toContain('🟢 Connected');
    // Display name split first/rest (no firstName/lastName column).
    expect(send.text).toContain('First name: Jane');
    expect(send.text).toContain('Last name: Appleseed');
    expect(send.text).toContain('Email: jane@example.com');
  });

  it('Open Menu renders a 🔴 Not connected card when no link is present', async () => {
    const harness = buildHarness();

    harness.linkingService.getStatus.mockResolvedValue({
      linked: false,
      telegramUsername: null,
      linkedAt: null,
    });

    await harness.service.handleKeyboardAction(USER, {
      action: KeyboardAction.OpenMenu,
      vendorChatId: CHAT_ID,
      correlationId: CID,
    });

    const send = lastKeyboardSend(harness.replyPresenter);

    expect(send.text).toContain('🔴 Not connected');
    expect(send.text).not.toContain('🟢 Connected');
  });

  it('Open Menu dedup-deletes the PRIOR menu card (different id), sending new first then deleting old', async () => {
    const harness = buildHarness();

    harness.lastMenu.take.mockResolvedValue('menu-msg-old');

    await harness.service.handleKeyboardAction(USER, {
      action: KeyboardAction.OpenMenu,
      vendorChatId: CHAT_ID,
      correlationId: CID,
    });

    // The new card was sent BEFORE the old one was deleted (never orphan).
    expect(harness.replyPresenter.sendTextWithKeyboard).toHaveBeenCalledTimes(
      1,
    );
    expect(harness.replyPresenter.deleteMessageQuietly).toHaveBeenCalledWith(
      CHAT_ID,
      'menu-msg-old',
      CID,
    );
    expect(harness.lastMenu.record).toHaveBeenCalledWith(
      'user-1',
      'menu-msg-new',
    );
  });

  it('Open Menu does NOT delete when there is no prior card (first open)', async () => {
    const harness = buildHarness();

    harness.lastMenu.take.mockResolvedValue(null);

    await harness.service.handleKeyboardAction(USER, {
      action: KeyboardAction.OpenMenu,
      vendorChatId: CHAT_ID,
      correlationId: CID,
    });

    expect(harness.replyPresenter.deleteMessageQuietly).not.toHaveBeenCalled();
  });

  it('Open Menu does NOT delete when the prior id is identical to the new id (no double-delete)', async () => {
    const harness = buildHarness();

    // A swallowed send returns null; if the prior id were also null they would be
    // "equal" — here we prove an identical non-null id is also never self-deleted.
    harness.lastMenu.take.mockResolvedValue('menu-msg-new');

    await harness.service.handleKeyboardAction(USER, {
      action: KeyboardAction.OpenMenu,
      vendorChatId: CHAT_ID,
      correlationId: CID,
    });

    expect(harness.replyPresenter.deleteMessageQuietly).not.toHaveBeenCalled();
  });

  it('Open Menu skips the dedup-delete and the record when the send was swallowed (null id)', async () => {
    const harness = buildHarness();

    harness.replyPresenter.sendTextWithKeyboard.mockResolvedValue(null);
    harness.lastMenu.take.mockResolvedValue(null);

    await harness.service.handleKeyboardAction(USER, {
      action: KeyboardAction.OpenMenu,
      vendorChatId: CHAT_ID,
      correlationId: CID,
    });

    expect(harness.replyPresenter.deleteMessageQuietly).not.toHaveBeenCalled();
    // No id to track when the send was swallowed.
    expect(harness.lastMenu.record).not.toHaveBeenCalled();
    // The surface is still marked Menu so the labels route on retry.
    expect(harness.activeKeyboard.setActiveSurface).toHaveBeenCalledWith(
      'user-1',
      KeyboardSurface.Menu,
    );
  });

  it('Menu Settings opens the settings keyboard and marks it the active surface', async () => {
    const harness = buildHarness();

    await harness.service.handleKeyboardAction(USER, {
      action: KeyboardAction.MenuSettings,
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

  it('Close Menu returns to the main keyboard and marks it the active surface', async () => {
    const harness = buildHarness();

    await harness.service.handleKeyboardAction(USER, {
      action: KeyboardAction.CloseMenu,
      vendorChatId: CHAT_ID,
      correlationId: CID,
    });

    const send = lastKeyboardSend(harness.replyPresenter);
    const labels = send.keyboard.buttons.flat().map((button) => button.label);

    expect(labels).toContain(KEYBOARD_LABELS.todaySchedule);
    expect(labels).toContain(KEYBOARD_LABELS.openMenu);
    expect(harness.activeKeyboard.setActiveSurface).toHaveBeenLastCalledWith(
      'user-1',
      KeyboardSurface.Main,
    );
  });

  it('Logout unlinks via LinkingService, clears the active surface AND the menu id, and removes the keyboard', async () => {
    const harness = buildHarness();

    await harness.service.handleKeyboardAction(USER, {
      action: KeyboardAction.Logout,
      vendorChatId: CHAT_ID,
      correlationId: CID,
    });

    expect(harness.linkingService.unlink).toHaveBeenCalledWith('user-1');
    expect(harness.activeKeyboard.clear).toHaveBeenCalledWith('user-1');
    expect(harness.lastMenu.clear).toHaveBeenCalledWith('user-1');
    expect(
      harness.replyPresenter.sendTextRemovingKeyboard,
    ).toHaveBeenCalledTimes(1);
    // No keyboard is re-docked on logout.
    expect(harness.replyPresenter.sendTextWithKeyboard).not.toHaveBeenCalled();
  });
});
