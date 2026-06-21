/**
 * L9 quick-reply builder — pure inline-keyboard button construction for the
 * keyboards the assistant emits: the `ask_user` quick-reply keyboard (ADR 0010)
 * and the STOP control (Story 14b). It owns NO vendor IO — it only maps domain
 * inputs to the vendor-agnostic {@link OutboundActionButton} rows, so the
 * {@link ReplyPresenter} stays the sole caller of `vendor.sendActions` while the
 * button shapes live in one tested place. (The ADR-0006 held-conflict keyboard
 * was removed with the deterministic hold — ADR 0011.)
 *
 * See `docs/specs/assistant-layered-architecture.md` → L9 reply/egress.
 */

import { AskUserOption } from '../assistant.types';
import {
  ASK_CALLBACK_PREFIX,
  STOP_CALLBACK_PREFIX,
} from '../ingress/inbound-router';
import { OutboundActionButton } from '@/modules/external-vendor/external-vendor.types';

/** Button label shown on the STOP control message (Story 14b / ADR 0043). */
const STOP_BUTTON_LABEL = '⏹ Stop';

/**
 * Builds the `ask_user` quick-reply keyboard (ADR 0010): one button per option,
 * each carrying `ask:<pendingQuestionId>:<optId>` callback data so the answer
 * resume can claim the row and map the chosen option back to its label. The
 * options are laid out as a single row.
 */
export const buildAskKeyboard = (
  options: AskUserOption[],
  pendingQuestionId: string,
): OutboundActionButton[][] => {
  return [
    options.map((option) => ({
      label: option.label,
      callbackData: `${ASK_CALLBACK_PREFIX}${pendingQuestionId}:${option.id}`,
    })),
  ];
};

/**
 * Builds the single STOP button row for the in-turn STOP control (Story 14b / ADR
 * 0043). Drafts carry no buttons, so STOP rides its OWN real message; the button's
 * callback data is `stop:<turnId>` (the in-flight turn's correlationId), which the
 * inbound router classifies and the deterministic STOP handler uses to arm the
 * per-user/per-turn STOP flag. One button, one row.
 */
export const buildStopKeyboard = (turnId: string): OutboundActionButton[][] => {
  return [
    [
      {
        label: STOP_BUTTON_LABEL,
        callbackData: `${STOP_CALLBACK_PREFIX}${turnId}`,
      },
    ],
  ];
};
