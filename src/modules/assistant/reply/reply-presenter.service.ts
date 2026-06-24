import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  escapeHtml,
  markdownToTelegramHtml,
} from './markdown-to-telegram-html';
import { buildAskKeyboard } from './quick-reply.builder';
import { StatusLocale } from './status-phrases';
import { AskUserOption } from '../assistant.types';
import { ExternalVendorConnector } from '@/modules/external-vendor/external-vendor-connector.abstract';
import { ACTIVE_VENDOR_CONNECTOR } from '@/modules/external-vendor/external-vendor.module';
import {
  OutboundFormat,
  ReplyKeyboard,
} from '@/modules/external-vendor/external-vendor.types';

/**
 * Localized "User selected:" prefix prepended to the answered `ask_user` question
 * when a button tap morphs the original question message (R3 / ADR 0058), so the
 * thread reads as a resolved exchange. Keyed by the turn's resolved
 * {@link StatusLocale}; collapses to English for any unsupported locale via the
 * caller's resolution chain.
 */
const USER_SELECTED_PREFIX: Record<StatusLocale, string> = {
  en: 'User selected:',
  ru: 'Вы выбрали:',
  uk: 'Ви обрали:',
};

/**
 * L9 reply / egress layer — the SOLE caller of the vendor send surface
 * (`sendMessage` / `sendActions` / `acknowledgeCallback`). The orchestrator
 * hands it WHAT to say; this layer owns HOW it reaches the vendor, so the
 * vendor connector is injected here and nowhere else in the assistant module.
 * Send failures are swallowed with a log (mirroring the queue's attempts:1
 * "every turn must answer" contract) rather than crashing the turn.
 *
 * See `docs/specs/assistant-layered-architecture.md` → L9 reply/egress.
 */
@Injectable()
export class ReplyPresenter {
  private readonly logger = new Logger(ReplyPresenter.name);

  constructor(
    @Inject(ACTIVE_VENDOR_CONNECTOR)
    private readonly vendor: ExternalVendorConnector,
  ) {}

  /**
   * Sends a model answer reply, formatted as Telegram HTML (ADR 0049): the model
   * writes Markdown, which Telegram would otherwise show literally, so the text
   * is converted to the safe HTML subset and sent with {@link OutboundFormat.Html}.
   * If that formatted send fails (e.g. a malformed-HTML 400, or the user blocked
   * the bot) it retries ONCE as PLAIN text (no parse_mode) so the user ALWAYS
   * gets the answer rather than silence. Returns the vendor message id of the
   * delivered message, or null when even the plain retry failed.
   *
   * `editMessageId` is the surface seam between the two status strategies (ADR
   * 0059). A PRIVATE turn drives an ephemeral draft and has NO real status message,
   * so the turn runner passes a null id here and the answer is a FRESH `sendMessage`
   * (the draft self-expires and Telegram replaces the preview with the delivered
   * message). A NON-PRIVATE turn keeps the ADR 0053 fallback — a real status message
   * whose id is passed here so the reply MORPHS it in place. See {@link morphInto}
   * for the edit + fallback chain.
   */
  async sendText(
    vendorChatId: string,
    text: string,
    correlationId?: string,
    editMessageId?: string | null,
  ): Promise<string | null> {
    if (editMessageId) {
      return this.morphInto(vendorChatId, editMessageId, text, correlationId);
    }

    const html = markdownToTelegramHtml(text);

    try {
      const ref = await this.vendor.sendMessage(
        { vendorChatId },
        { text: html, format: OutboundFormat.Html },
      );

      return ref.vendorMessageId;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';

      this.logger.warn(
        `[cid=${correlationId ?? 'none'}] HTML reply to ${vendorChatId} failed (${message}); retrying as plain text`,
      );

      return this.sendPlainTextFallback(vendorChatId, text, correlationId);
    }
  }

  /**
   * Morphs the turn's live status message into the final answer (ADR 0053) by
   * editing it in place: HTML first, then a PLAIN-text edit if the HTML edit 400s.
   * If neither edit lands (e.g. the message was deleted, or is too old to edit),
   * it falls back to sending a FRESH reply message AND retires the stale status
   * message via {@link deleteQuietly}, so the user is never left with a dangling
   * "thinking…" bubble next to the answer. Returns the id of the message the
   * answer ended up on (the edited one on success, the fresh one on fallback), or
   * null when even the fresh send failed.
   */
  private async morphInto(
    vendorChatId: string,
    editMessageId: string,
    text: string,
    correlationId?: string,
  ): Promise<string | null> {
    const html = markdownToTelegramHtml(text);

    try {
      await this.vendor.editMessageText(
        { vendorChatId },
        {
          vendorMessageId: editMessageId,
          text: html,
          format: OutboundFormat.Html,
        },
      );

      return editMessageId;
    } catch (htmlError) {
      const htmlMessage =
        htmlError instanceof Error ? htmlError.message : 'unknown error';

      this.logger.warn(
        `[cid=${correlationId ?? 'none'}] HTML morph of ${editMessageId} failed (${htmlMessage}); retrying as plain-text edit`,
      );

      try {
        await this.vendor.editMessageText(
          { vendorChatId },
          { vendorMessageId: editMessageId, text },
        );

        return editMessageId;
      } catch (plainError) {
        const plainMessage =
          plainError instanceof Error ? plainError.message : 'unknown error';

        this.logger.warn(
          `[cid=${correlationId ?? 'none'}] Plain morph of ${editMessageId} also failed (${plainMessage}); sending a fresh reply and retiring the stale status message`,
        );

        const freshId = await this.sendText(vendorChatId, text, correlationId);

        // Only retire the stale status message once the fresh reply actually
        // landed — if the fresh send ALSO failed, keep it as the user's sole
        // remaining message rather than leaving the chat with nothing.
        if (freshId) {
          await this.deleteQuietly(vendorChatId, editMessageId, correlationId);
        }

        return freshId;
      }
    }
  }

  /**
   * Deletes a message best-effort, swallowing any fault with a log — used to
   * retire the stale status message when a morph fell back to a fresh send so it
   * never lingers as a second bubble. A failed delete is cosmetic.
   */
  private async deleteQuietly(
    vendorChatId: string,
    vendorMessageId: string,
    correlationId?: string,
  ): Promise<void> {
    try {
      await this.vendor.deleteMessage({ vendorChatId }, vendorMessageId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';

      this.logger.warn(
        `[cid=${correlationId ?? 'none'}] Failed to retire stale status message ${vendorMessageId}: ${message}`,
      );
    }
  }

  /**
   * Last-resort PLAIN-text send (no parse_mode) used when the formatted
   * {@link sendText} attempt failed. Sends the ORIGINAL (un-converted) text so a
   * formatting bug never strips meaning, swallowing a second failure with a log
   * so a blocked-bot / down-vendor never crashes the turn. Returns the delivered
   * message id, or null when this final attempt also failed.
   */
  private async sendPlainTextFallback(
    vendorChatId: string,
    text: string,
    correlationId?: string,
  ): Promise<string | null> {
    try {
      const ref = await this.vendor.sendMessage({ vendorChatId }, { text });

      return ref.vendorMessageId;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';

      this.logger.warn(
        `[cid=${correlationId ?? 'none'}] Plain-text reply to ${vendorChatId} also failed: ${message}`,
      );

      return null;
    }
  }

  /**
   * Sends an `ask_user` question: a plain text message when there are no options,
   * else an inline keyboard with one button per option (callback data
   * `ask:<pendingQuestionId>:<optId>`). A draft cannot carry inline buttons, so a
   * PRIVATE turn passes a null `editMessageId` and the question is a FRESH real
   * `sendMessage` / `sendActions` (ADR 0059); a NON-PRIVATE turn keeps the ADR 0053
   * morph onto its real status message. Each path swallows a send failure with a
   * log (mirroring {@link sendText}) and returns the outbound vendor message id
   * (or null) so the persisted assistant message can reference it AND the orch can
   * capture it for the answered-question morph (R3 / ADR 0058). The fresh-keyboard
   * fallback ALSO returns its `sendActions` message id so Feature 1 works on BOTH
   * the morph and fresh-keyboard paths.
   */
  async sendQuestion(
    vendorChatId: string,
    question: string,
    options: AskUserOption[],
    pendingQuestionId: string,
    correlationId: string,
    editMessageId?: string | null,
  ): Promise<string | null> {
    if (options.length === 0) {
      return this.sendText(
        vendorChatId,
        question,
        correlationId,
        editMessageId,
      );
    }

    const buttons = buildAskKeyboard(options, pendingQuestionId);

    // Morph the live status message into the question + inline keyboard (ADR
    // 0053) so the ask reuses the one message instead of spawning a second.
    if (editMessageId) {
      try {
        await this.vendor.editMessageText(
          { vendorChatId },
          { vendorMessageId: editMessageId, text: question, buttons },
        );

        return editMessageId;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'unknown error';

        this.logger.warn(
          `[cid=${correlationId}] Morph of ask_user keyboard onto ${editMessageId} failed (${message}); sending a fresh keyboard`,
        );
      }
    }

    // Fresh keyboard (no morph, or the morph failed). Retire the stale status
    // message ONLY after the fresh keyboard actually landed — otherwise keep it,
    // so a double-failure never leaves the chat with nothing. Capture the fresh
    // message id (R3 / ADR 0058) so the answered-question morph can later target
    // the question on the fresh-keyboard path too.
    try {
      const ref = await this.vendor.sendActions(
        { vendorChatId },
        { text: question, buttons },
      );

      if (editMessageId) {
        await this.deleteQuietly(vendorChatId, editMessageId, correlationId);
      }

      return ref.vendorMessageId;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';

      this.logger.warn(
        `[cid=${correlationId}] Failed to send ask_user keyboard to ${vendorChatId}: ${message}`,
      );

      return null;
    }
  }

  /**
   * Marks an `ask_user` question as answered on a BUTTON tap (R3 / ADR 0058) by
   * editing the ORIGINAL question message in place: it removes the (now-stale)
   * inline keyboard and appends a localized "User selected: <label>" line, so the
   * question reads as a resolved exchange instead of a dangling tappable card. Sent
   * as HTML with both the question and the chosen label escaped (the question was
   * authored by the model and the label is user-facing button text — neither is
   * trusted HTML). Degrade-never-throw: a failed edit (message too old / deleted)
   * is swallowed with a log — the morph is cosmetic, and the resume's own reply
   * still lands separately.
   */
  async markQuestionAnswered(
    vendorChatId: string,
    questionMessageId: string,
    originalQuestion: string,
    answerLabel: string,
    locale: StatusLocale,
    correlationId?: string,
  ): Promise<void> {
    const prefix = USER_SELECTED_PREFIX[locale];
    const text = `${escapeHtml(originalQuestion)}\n\n${prefix} ${escapeHtml(answerLabel)}`;

    try {
      await this.vendor.editMessageText(
        { vendorChatId },
        {
          vendorMessageId: questionMessageId,
          text,
          format: OutboundFormat.Html,
          clearButtons: true,
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';

      this.logger.warn(
        `[cid=${correlationId ?? 'none'}] Failed to mark question ${questionMessageId} answered: ${message}`,
      );
    }
  }

  /**
   * Sends a text message that ALSO docks a persistent reply keyboard (Story 16 /
   * ADR 0045), via the Story-10 {@link ExternalVendorConnector.sendMessageWithKeyboard}
   * primitive (`is_persistent` + `resize_keyboard`). Swapping the docked keyboard
   * is just sending a new message with the other keyboard's markup. Swallows a send
   * failure with a log (mirroring {@link sendText}) so a keyboard send can never
   * crash the deterministic keyboard path; an optional `format` carries through (the
   * ASCII calendar is sent as Markdown so it lands in a monospace code block).
   *
   * Returns the delivered message's vendor message id (R4 / ADR 0056 — the Menu
   * surface needs it to dedup-delete the prior menu card), or null when the send
   * was swallowed. The swallow-and-log-never-throw contract is preserved: this
   * remains the sole vendor-send chokepoint and never rethrows.
   */
  async sendTextWithKeyboard(
    vendorChatId: string,
    text: string,
    keyboard: ReplyKeyboard,
    format?: OutboundFormat,
    correlationId?: string,
  ): Promise<string | null> {
    try {
      const ref = await this.vendor.sendMessageWithKeyboard(
        { vendorChatId },
        { text, format, replyKeyboard: keyboard },
      );

      return ref.vendorMessageId;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';

      this.logger.warn(
        `[cid=${correlationId ?? 'none'}] Failed to send keyboard message to ${vendorChatId}: ${message}`,
      );

      return null;
    }
  }

  /**
   * Public best-effort delete (R4 / ADR 0056) — a thin wrapper over the private
   * {@link deleteQuietly} so the Menu surface can retire its prior menu card after
   * sending the new one (send-new-first, delete-old-after, never orphaning). Swallows
   * any fault with a log; a failed delete is cosmetic (worst case one extra bubble).
   */
  async deleteMessageQuietly(
    vendorChatId: string,
    vendorMessageId: string,
    correlationId?: string,
  ): Promise<void> {
    await this.deleteQuietly(vendorChatId, vendorMessageId, correlationId);
  }

  /**
   * Sends a text message that REMOVES any docked persistent reply keyboard (Story
   * 16 / ADR 0045) via the `ReplyKeyboardRemove` sentinel — used by Disconnect so
   * the keyboard vanishes once the chat is unlinked. Swallows a send failure with a
   * log (mirroring {@link sendText}).
   */
  async sendTextRemovingKeyboard(
    vendorChatId: string,
    text: string,
    correlationId?: string,
  ): Promise<void> {
    try {
      await this.vendor.sendMessageWithKeyboard(
        { vendorChatId },
        { text, replyKeyboard: { remove: true } },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';

      this.logger.warn(
        `[cid=${correlationId ?? 'none'}] Failed to remove keyboard for ${vendorChatId}: ${message}`,
      );
    }
  }

  /**
   * Acknowledges a callback (button tap) so the client stops its loading
   * spinner. Delegates straight to the vendor connector.
   */
  async acknowledgeCallback(callbackId: string): Promise<void> {
    await this.vendor.acknowledgeCallback(callbackId);
  }
}
