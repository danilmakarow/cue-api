import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  buildAskKeyboard,
  buildHeldKeyboard,
  buildStopKeyboard,
} from './quick-reply.builder';
import { AskUserOption } from '../assistant.types';
import { ExternalVendorConnector } from '@/modules/external-vendor/external-vendor-connector.abstract';
import { ACTIVE_VENDOR_CONNECTOR } from '@/modules/external-vendor/external-vendor.module';

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
   * Sends a plain text reply, swallowing a send failure (e.g. the user blocked
   * the bot) with a log rather than crashing the turn. Returns the vendor
   * message id when the send succeeded, or null when it failed.
   */
  async sendText(
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
        `[cid=${correlationId ?? 'none'}] Failed to send reply to ${vendorChatId}: ${message}`,
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
   * Sends the held-conflict confirmation keyboard (ADR 0006): the prompt text
   * plus a single confirm/cancel button row whose callback data carries the
   * Redis hold token. The model is never re-invoked — the user's tap resumes or
   * cancels the held action deterministically.
   */
  async sendHeldKeyboard(
    vendorChatId: string,
    promptText: string,
    heldCount: number,
    token: string,
  ): Promise<void> {
    await this.vendor.sendActions(
      { vendorChatId },
      {
        text: promptText,
        buttons: buildHeldKeyboard(heldCount, token),
      },
    );
  }

  /**
   * Sends the in-turn STOP control (Story 14b / ADR 0043): a SEPARATE real message
   * (drafts carry no buttons) carrying a single STOP button whose callback data is
   * `stop:<turnId>`. Shown while the turn runs; the returned vendor message id lets
   * the turn runner delete it when the turn ends ({@link removeStopControl}).
   * Swallows a send failure with a log (mirroring {@link sendText}) and returns null
   * — a missing STOP control simply means the turn cannot be cooperatively stopped,
   * never a broken turn.
   */
  async sendStopControl(
    vendorChatId: string,
    turnId: string,
    correlationId?: string,
  ): Promise<string | null> {
    try {
      const ref = await this.vendor.sendActions(
        { vendorChatId },
        {
          text: 'Working on it…',
          buttons: buildStopKeyboard(turnId),
        },
      );

      return ref.vendorMessageId;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';

      this.logger.warn(
        `[cid=${correlationId ?? 'none'}] Failed to send STOP control to ${vendorChatId}: ${message}`,
      );

      return null;
    }
  }

  /**
   * Removes the in-turn STOP control message once the turn ends (Story 14b / ADR
   * 0043), so a finished turn leaves no dangling STOP button. A no-op when no
   * control was sent (null id). Swallows a delete failure with a log — a stale STOP
   * button is harmless (its callback arms a flag for an already-finished, turn-
   * scoped key that nothing polls).
   */
  async removeStopControl(
    vendorChatId: string,
    vendorMessageId: string | null,
    correlationId?: string,
  ): Promise<void> {
    if (!vendorMessageId) {
      return;
    }

    try {
      await this.vendor.deleteMessage({ vendorChatId }, vendorMessageId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';

      this.logger.debug(
        `[cid=${correlationId ?? 'none'}] Failed to remove STOP control ${vendorMessageId} in ${vendorChatId}: ${message}`,
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
