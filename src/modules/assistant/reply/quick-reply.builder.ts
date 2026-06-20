/**
 * L9 quick-reply builder — pure inline-keyboard button construction for the two
 * keyboards the assistant emits: the held-conflict confirm/cancel keyboard (ADR
 * 0006) and the `ask_user` quick-reply keyboard (ADR 0010). It owns NO vendor IO
 * — it only maps domain inputs to the vendor-agnostic {@link
 * OutboundActionButton} rows, so the {@link ReplyPresenter} stays the sole
 * caller of `vendor.sendActions` while the button shapes live in one tested place.
 *
 * See `docs/specs/assistant-layered-architecture.md` → L9 reply/egress.
 */

import { AskUserOption, ConflictCallbackAction } from '../assistant.types';
import { ASK_CALLBACK_PREFIX } from '../ingress/inbound-router';
import { OutboundActionButton } from '@/modules/external-vendor/external-vendor.types';

/**
 * Builds the single confirm/cancel button row for a held-conflict keyboard (ADR
 * 0006). The confirm label pluralizes for a batch ("Book all anyway") vs a
 * single hold ("Book anyway"); both buttons carry `confirm:<token>` /
 * `cancel:<token>` callback data so the deterministic conflict handler can
 * resolve the tap without re-invoking the model.
 */
export const buildHeldKeyboard = (
  heldCount: number,
  token: string,
): OutboundActionButton[][] => {
  return [
    [
      {
        label: heldCount > 1 ? 'Book all anyway' : 'Book anyway',
        callbackData: `${ConflictCallbackAction.CONFIRM}:${token}`,
      },
      {
        label: 'Cancel',
        callbackData: `${ConflictCallbackAction.CANCEL}:${token}`,
      },
    ],
  ];
};

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
