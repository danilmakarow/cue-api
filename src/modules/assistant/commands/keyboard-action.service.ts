import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';

import { LinkingService } from '../linking.service';
import { renderAsciiCalendar } from '../reply/ascii-calendar';
import {
  KeyboardAction,
  KeyboardSurface,
  MAIN_KEYBOARD,
  SETTINGS_KEYBOARD,
} from '../reply/reply-keyboard.layout';
import { ReplyPresenter } from '../reply/reply-presenter.service';
import { ScheduleReaderService } from '../schedule-reader.service';
import { ActiveKeyboardStore } from '../session/active-keyboard.store';
import { LastButtonStore } from '../session/last-button.store';
import { User } from '@/modules/database/entities';
import { OutboundFormat } from '@/modules/external-vendor/external-vendor.types';

/** Parameters for handling a resolved reply-keyboard action (Story 16 / ADR 0045). */
export interface HandleKeyboardActionParams {
  action: KeyboardAction;
  vendorChatId: string;
  /** Correlation id threaded from the webhook; minted here if absent. */
  correlationId?: string;
}

/** Number of days the "Next week" view spans (today + the following 6 local days). */
const NEXT_WEEK_DAYS = 7;

/** Reply shown when the schedule read fails — the action degrades, never throws. */
const SCHEDULE_UNAVAILABLE_REPLY =
  "I couldn't pull up your schedule just now — please try again in a moment.";

/** Reply shown after a successful Disconnect (the keyboard is removed alongside). */
const DISCONNECT_REPLY =
  "You're disconnected. I won't see your Telegram messages until you reconnect from the Cue app.";

/**
 * The deterministic, no-LLM reply-keyboard action surface (Story 16 / ADR 0045) —
 * the keyboard sibling of {@link AssistantService}'s slash-command facade. Every
 * action here resolves WITHOUT the model: render today's / next-week's ASCII
 * calendar from {@link ScheduleReaderService} (a direct read), swap between the
 * main and settings keyboards, or Disconnect (unlink via {@link LinkingService} +
 * remove the keyboard). After each action it overwrites the latest-button line in
 * Redis ({@link LastButtonStore}) so the NEXT model turn sees what the user just
 * did — injected into the volatile tail only (ADR 0004 cache stability), never the
 * cached prefix. Sends + Redis writes all degrade never-throw, preserving the
 * `attempts:1` "every turn must answer" posture.
 *
 * See `docs/adr/0045-assistant-reply-keyboard-and-calendar.md`.
 */
@Injectable()
export class KeyboardActionService {
  private readonly logger = new Logger(KeyboardActionService.name);

  constructor(
    private readonly scheduleReader: ScheduleReaderService,
    private readonly replyPresenter: ReplyPresenter,
    private readonly linkingService: LinkingService,
    private readonly activeKeyboard: ActiveKeyboardStore,
    private readonly lastButton: LastButtonStore,
  ) {}

  /**
   * Docks the MAIN reply keyboard for the user and records it as the active
   * surface, so a subsequent text-equality tap is routed only against the main
   * keyboard's labels. Sent best-effort (degrade-never-throw). Used by the linking
   * success path and the [Back] action.
   */
  async showMainKeyboard(
    user: User,
    vendorChatId: string,
    text: string,
    correlationId: string,
  ): Promise<void> {
    await this.replyPresenter.sendTextWithKeyboard(
      vendorChatId,
      text,
      MAIN_KEYBOARD,
      undefined,
      correlationId,
    );
    await this.activeKeyboard.setActiveSurface(user.id, KeyboardSurface.Main);
  }

  /**
   * Handles one resolved reply-keyboard action deterministically (no LLM): renders
   * the requested ASCII calendar, swaps the keyboard surface, or disconnects. Each
   * branch writes a latest-button line for the next turn's volatile tail. Never
   * throws — every send / read / Redis write it calls already swallows its own
   * fault, so a keyboard tap on the `attempts:1` path can never break a turn.
   */
  async handleKeyboardAction(
    user: User,
    params: HandleKeyboardActionParams,
  ): Promise<void> {
    const correlationId = params.correlationId ?? randomUUID();

    this.logger.log(
      `[cid=${correlationId}] keyboard action ${params.action} for user ${user.id}`,
    );

    if (params.action === KeyboardAction.TodaySchedule) {
      await this.renderTodaySchedule(user, params.vendorChatId, correlationId);

      return;
    }

    if (params.action === KeyboardAction.NextWeek) {
      await this.renderNextWeek(user, params.vendorChatId, correlationId);

      return;
    }

    if (params.action === KeyboardAction.OpenSettings) {
      await this.openSettings(user, params.vendorChatId, correlationId);

      return;
    }

    if (params.action === KeyboardAction.Back) {
      await this.goBackToMain(user, params.vendorChatId, correlationId);

      return;
    }

    await this.disconnect(user, params.vendorChatId, correlationId);
  }

  /**
   * Renders today's schedule (start-of-today → start-of-tomorrow, in the user's
   * timezone) as a monospace ASCII calendar and sends it under the main keyboard,
   * then records the latest-button line. A schedule read failure degrades to a
   * friendly retry reply, never a thrown turn.
   */
  private async renderTodaySchedule(
    user: User,
    vendorChatId: string,
    correlationId: string,
  ): Promise<void> {
    const from = DateTime.now().setZone(user.timezone).startOf('day');
    const to = from.plus({ days: 1 });

    await this.renderCalendar(user, vendorChatId, correlationId, {
      title: 'Today',
      from: from.toJSDate(),
      to: to.toJSDate(),
      outcomeLine: "Showed today's schedule.",
    });
  }

  /**
   * Renders the next 7 local days (today + 6) as a monospace ASCII calendar and
   * sends it under the main keyboard, then records the latest-button line. A read
   * failure degrades to a friendly retry reply.
   */
  private async renderNextWeek(
    user: User,
    vendorChatId: string,
    correlationId: string,
  ): Promise<void> {
    const from = DateTime.now().setZone(user.timezone).startOf('day');
    const to = from.plus({ days: NEXT_WEEK_DAYS });

    await this.renderCalendar(user, vendorChatId, correlationId, {
      title: `Next ${NEXT_WEEK_DAYS} days`,
      from: from.toJSDate(),
      to: to.toJSDate(),
      outcomeLine: "Showed the next week's schedule.",
    });
  }

  /**
   * Shared calendar render+send: reads occurrences for `[from, to)` via the
   * schedule reader, renders the ASCII calendar in the user's timezone, sends it as
   * a Markdown code block (so the monospace columns align) under the main keyboard,
   * and records the outcome line. Wraps the read in try/catch so any read failure
   * (e.g. a transient DB blip) sends the retry reply instead of throwing.
   */
  private async renderCalendar(
    user: User,
    vendorChatId: string,
    correlationId: string,
    spec: { title: string; from: Date; to: Date; outcomeLine: string },
  ): Promise<void> {
    try {
      const occurrences = await this.scheduleReader.occurrencesInRange(
        user.id,
        spec.from,
        spec.to,
      );
      const calendar = renderAsciiCalendar({
        title: spec.title,
        from: spec.from,
        to: spec.to,
        occurrences,
        timezone: user.timezone,
      });

      await this.replyPresenter.sendTextWithKeyboard(
        vendorChatId,
        this.asCodeBlock(calendar),
        MAIN_KEYBOARD,
        OutboundFormat.Markdown,
        correlationId,
      );
      await this.activeKeyboard.setActiveSurface(user.id, KeyboardSurface.Main);
      await this.lastButton.record(user.id, spec.outcomeLine);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';

      this.logger.warn(
        `[cid=${correlationId}] schedule read failed for user ${user.id}: ${message}`,
      );

      await this.replyPresenter.sendTextWithKeyboard(
        vendorChatId,
        SCHEDULE_UNAVAILABLE_REPLY,
        MAIN_KEYBOARD,
        undefined,
        correlationId,
      );
    }
  }

  /**
   * Opens the settings surface: docks the [Disconnect] [Back] keyboard, marks it
   * the active surface (so only those two labels route as taps now), and records
   * the outcome line.
   */
  private async openSettings(
    user: User,
    vendorChatId: string,
    correlationId: string,
  ): Promise<void> {
    await this.replyPresenter.sendTextWithKeyboard(
      vendorChatId,
      'Settings',
      SETTINGS_KEYBOARD,
      undefined,
      correlationId,
    );
    await this.activeKeyboard.setActiveSurface(
      user.id,
      KeyboardSurface.Settings,
    );
    await this.lastButton.record(user.id, 'Opened Settings.');
  }

  /**
   * Returns from settings to the main surface: re-docks the main keyboard, marks it
   * active, and records the outcome line.
   */
  private async goBackToMain(
    user: User,
    vendorChatId: string,
    correlationId: string,
  ): Promise<void> {
    await this.showMainKeyboard(
      user,
      vendorChatId,
      'Back to the main menu.',
      correlationId,
    );
    await this.lastButton.record(user.id, 'Returned to the main menu.');
  }

  /**
   * Disconnects the chat: unlinks the Telegram link via {@link LinkingService}
   * (the existing unlink path, idempotent), removes the docked keyboard
   * (`ReplyKeyboardRemove`), and clears the active-surface flag so a later typed
   * label is plain conversation. The latest-button line is recorded last so the
   * (now unlinked) user — should they reconnect — still has the context. The
   * unlink runs first so even if the keyboard send fails the binding is gone.
   */
  private async disconnect(
    user: User,
    vendorChatId: string,
    correlationId: string,
  ): Promise<void> {
    await this.linkingService.unlink(user.id);
    await this.activeKeyboard.clear(user.id);
    await this.replyPresenter.sendTextRemovingKeyboard(
      vendorChatId,
      DISCONNECT_REPLY,
      correlationId,
    );
    await this.lastButton.record(user.id, 'Disconnected Telegram.');
  }

  /**
   * Wraps the calendar text in a triple-backtick code block so the vendor renders
   * it monospace (columns align). The renderer already bounds every line to the
   * ASCII-calendar mobile width, so the block stays within phone width.
   */
  private asCodeBlock(calendar: string): string {
    return `\`\`\`\n${calendar}\n\`\`\``;
  }
}
