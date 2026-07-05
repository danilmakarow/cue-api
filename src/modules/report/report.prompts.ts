/**
 * Static prompt copy for the daily notification report (Story 17 / ADR 0046).
 * Mirrors the assistant's J.A.R.V.I.S. register but is a ONE-SHOT generation — no
 * tools, no loop — so the copy is self-contained here rather than shared with the
 * assistant's turn prompts.
 */

/**
 * System prompt for the one-shot daily report. Asks for a short, friendly
 * morning briefing over the user's agenda. Kept tight so a single MAIN-model
 * completion stays cheap and the output fits comfortably in one Telegram message.
 */
export const DAILY_REPORT_SYSTEM_PROMPT = `You are Cue, a personal scheduling assistant in the manner of J.A.R.V.I.S. — composed, impeccably polite, and quietly warm.

Write a SHORT daily briefing for the user's day ahead, in 2–4 sentences:
- Open with a brief, warm greeting.
- Summarize what's on their schedule today in plain prose (not a bullet list), in chronological order, mentioning times naturally.
- If there is nothing scheduled, say so kindly and reassuringly — do not invent items.
- You may use light Markdown for emphasis (bold, italics) and short lists where it genuinely aids clarity; keep formatting minimal. No headings, no emoji.
- Never mention tools, models, or that you are an AI. Just the briefing.`;

/**
 * Heading for the optional per-user preferences section appended to the base
 * daily-brief prompt. Kept as a constant so the generator and its tests agree on
 * the exact marker.
 */
export const BRIEF_USER_PREFERENCES_HEADING =
  'User preferences for the briefing:';

/**
 * Builds the effective daily-brief system prompt for a user. When the user has a
 * non-empty `customPrompt`, it is APPENDED to the base prompt as an additional
 * "User preferences for the briefing:" section — it AUGMENTS the base prompt, so
 * the base structure / safety / format rules always hold and the custom text only
 * personalizes tone and content. A null / empty / whitespace-only custom prompt
 * yields the base prompt unchanged.
 */
export const buildDailyReportSystemPrompt = (
  customPrompt: string | null,
): string => {
  const trimmed = customPrompt?.trim();

  if (!trimmed) {
    return DAILY_REPORT_SYSTEM_PROMPT;
  }

  return `${DAILY_REPORT_SYSTEM_PROMPT}\n\n${BRIEF_USER_PREFERENCES_HEADING}\n${trimmed}`;
};
