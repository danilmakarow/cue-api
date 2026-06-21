import { Inject, Injectable, Logger } from '@nestjs/common';

import { markdownToTelegramHtml } from './markdown-to-telegram-html';
import { buildAskKeyboard } from './quick-reply.builder';
import { AskUserOption } from '../assistant.types';
import { ExternalVendorConnector } from '@/modules/external-vendor/external-vendor-connector.abstract';
import { ACTIVE_VENDOR_CONNECTOR } from '@/modules/external-vendor/external-vendor.module';
import {
  OutboundFormat,
  ReplyKeyboard,
} from '@/modules/external-vendor/external-vendor.types';

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
   */
  async sendText(
    vendorChatId: string,
    text: string,
    correlationId?: string,
  ): Promise<string | null> {
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
   * `ask:<pendingQuestionId>:<optId>`). Each path swallows a send failure with a
   * log (mirroring {@link sendText}) and returns the outbound vendor message id
   * (or null) so the persisted assistant message can reference it. A keyboard send
   * has no per-message id to thread back, so it returns null.
   */
  async sendQuestion(
    vendorChatId: string,
    question: string,
    options: AskUserOption[],
    pendingQuestionId: string,
    correlationId: string,
  ): Promise<string | null> {
    if (options.length === 0) {
      return this.sendText(vendorChatId, question, correlationId);
    }

    try {
      await this.vendor.sendActions(
        { vendorChatId },
        {
          text: question,
          buttons: buildAskKeyboard(options, pendingQuestionId),
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';

      this.logger.warn(
        `[cid=${correlationId}] Failed to send ask_user keyboard to ${vendorChatId}: ${message}`,
      );
    }

    return null;
  }

  /**
   * Sends a text message that ALSO docks a persistent reply keyboard (Story 16 /
   * ADR 0045), via the Story-10 {@link ExternalVendorConnector.sendMessageWithKeyboard}
   * primitive (`is_persistent` + `resize_keyboard`). Swapping the docked keyboard
   * is just sending a new message with the other keyboard's markup. Swallows a send
   * failure with a log (mirroring {@link sendText}) so a keyboard send can never
   * crash the deterministic keyboard path; an optional `format` carries through (the
   * ASCII calendar is sent as Markdown so it lands in a monospace code block).
   */
  async sendTextWithKeyboard(
    vendorChatId: string,
    text: string,
    keyboard: ReplyKeyboard,
    format?: OutboundFormat,
    correlationId?: string,
  ): Promise<void> {
    try {
      await this.vendor.sendMessageWithKeyboard(
        { vendorChatId },
        { text, format, replyKeyboard: keyboard },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';

      this.logger.warn(
        `[cid=${correlationId ?? 'none'}] Failed to send keyboard message to ${vendorChatId}: ${message}`,
      );
    }
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
