import { ReplyPresenter } from './reply-presenter.service';
import { OutboundFormat } from '@/modules/external-vendor/external-vendor.types';

/** Builds a vendor connector fake covering the send surface ReplyPresenter uses. */
const buildVendor = () => ({
  sendMessage: jest.fn().mockResolvedValue({ vendorMessageId: '555' }),
  sendActions: jest.fn().mockResolvedValue({ vendorMessageId: '777' }),
  sendMessageWithKeyboard: jest
    .fn()
    .mockResolvedValue({ vendorMessageId: '888' }),
  editMessageText: jest.fn().mockResolvedValue(undefined),
  deleteMessage: jest.fn().mockResolvedValue(undefined),
  acknowledgeCallback: jest.fn().mockResolvedValue(undefined),
});

const buildPresenter = () => {
  const vendor = buildVendor();
  const presenter = new ReplyPresenter(vendor as never);

  return { presenter, vendor };
};

describe('ReplyPresenter.sendText (ADR 0049 Markdown→HTML + plain fallback)', () => {
  it('converts the answer Markdown to HTML and sends it with OutboundFormat.Html', async () => {
    const { presenter, vendor } = buildPresenter();

    const id = await presenter.sendText('chat-1', 'say **hi** now', 'cid-1');

    expect(id).toBe('555');
    expect(vendor.sendMessage).toHaveBeenCalledTimes(1);

    const [target, message] = vendor.sendMessage.mock.calls[0];

    expect(target).toEqual({ vendorChatId: 'chat-1' });
    expect(message).toEqual({
      text: 'say <b>hi</b> now',
      format: OutboundFormat.Html,
    });
  });

  it('retries ONCE as plain text (no format) when the formatted send rejects, and still returns the id', async () => {
    const { presenter, vendor } = buildPresenter();

    vendor.sendMessage
      .mockRejectedValueOnce(new Error("Bad Request: can't parse entities"))
      .mockResolvedValueOnce({ vendorMessageId: '999' });

    const id = await presenter.sendText('chat-1', 'tricky **md**', 'cid-2');

    // The user still got the answer via the plain retry.
    expect(id).toBe('999');
    expect(vendor.sendMessage).toHaveBeenCalledTimes(2);

    // First attempt was HTML-formatted; the retry is plain (no format) and uses
    // the ORIGINAL un-converted text so a formatting bug never strips meaning.
    const [, firstMessage] = vendor.sendMessage.mock.calls[0];
    const [, secondMessage] = vendor.sendMessage.mock.calls[1];

    expect(firstMessage.format).toBe(OutboundFormat.Html);
    expect(secondMessage).toEqual({ text: 'tricky **md**' });
    expect(secondMessage.format).toBeUndefined();
  });

  it('returns null (never throws) when BOTH the formatted and plain sends fail', async () => {
    const { presenter, vendor } = buildPresenter();

    vendor.sendMessage.mockRejectedValue(new Error('blocked'));

    const id = await presenter.sendText('chat-1', 'hello', 'cid-3');

    expect(id).toBeNull();
    expect(vendor.sendMessage).toHaveBeenCalledTimes(2);
  });
});

describe('ReplyPresenter.sendText morph (ADR 0053 one-message-per-turn)', () => {
  it('EDITS the live status message in place as HTML and returns that message id (no second bubble)', async () => {
    const { presenter, vendor } = buildPresenter();

    const id = await presenter.sendText(
      'chat-1',
      'say **hi** now',
      'cid-morph-1',
      'status-42',
    );

    // The answer morphed the status message: edit, not a fresh send.
    expect(id).toBe('status-42');
    expect(vendor.editMessageText).toHaveBeenCalledTimes(1);
    expect(vendor.sendMessage).not.toHaveBeenCalled();
    expect(vendor.deleteMessage).not.toHaveBeenCalled();

    const [target, edit] = vendor.editMessageText.mock.calls[0];

    expect(target).toEqual({ vendorChatId: 'chat-1' });
    expect(edit).toEqual({
      vendorMessageId: 'status-42',
      text: 'say <b>hi</b> now',
      format: OutboundFormat.Html,
    });
  });

  it('retries a PLAIN-text edit (no format, original text) when the HTML edit rejects, still on the same message', async () => {
    const { presenter, vendor } = buildPresenter();

    vendor.editMessageText
      .mockRejectedValueOnce(new Error("Bad Request: can't parse entities"))
      .mockResolvedValueOnce(undefined);

    const id = await presenter.sendText(
      'chat-1',
      'tricky **md**',
      'cid-morph-2',
      'status-42',
    );

    // Still the same message — the plain edit landed; no fresh send, no delete.
    expect(id).toBe('status-42');
    expect(vendor.editMessageText).toHaveBeenCalledTimes(2);
    expect(vendor.sendMessage).not.toHaveBeenCalled();
    expect(vendor.deleteMessage).not.toHaveBeenCalled();

    const [, firstEdit] = vendor.editMessageText.mock.calls[0];
    const [, secondEdit] = vendor.editMessageText.mock.calls[1];

    // First attempt was HTML; the retry is plain (no format) with the ORIGINAL text.
    expect(firstEdit.format).toBe(OutboundFormat.Html);
    expect(secondEdit).toEqual({
      vendorMessageId: 'status-42',
      text: 'tricky **md**',
    });
    expect(secondEdit.format).toBeUndefined();
  });

  it('sends a FRESH message AND retires the stale status message when BOTH edits fail, returning the fresh id', async () => {
    const { presenter, vendor } = buildPresenter();

    vendor.editMessageText.mockRejectedValue(
      new Error('message to edit not found'),
    );
    vendor.sendMessage.mockResolvedValue({ vendorMessageId: 'fresh-99' });

    const id = await presenter.sendText(
      'chat-1',
      'hello',
      'cid-morph-3',
      'status-42',
    );

    // Both edits attempted, then a fresh send carried the answer.
    expect(vendor.editMessageText).toHaveBeenCalledTimes(2);
    expect(vendor.sendMessage).toHaveBeenCalledTimes(1);
    expect(id).toBe('fresh-99');

    // The stale "thinking…" status message is deleted so it never lingers.
    expect(vendor.deleteMessage).toHaveBeenCalledTimes(1);
    expect(vendor.deleteMessage).toHaveBeenCalledWith(
      { vendorChatId: 'chat-1' },
      'status-42',
    );
  });
});

describe('ReplyPresenter.sendQuestion morph (ADR 0053 ask_user reuses the status message)', () => {
  const options = [
    { id: 'a', label: 'Yes' },
    { id: 'b', label: 'No' },
  ];

  it('EDITS the status message into the question + inline keyboard and returns that id (no fresh keyboard)', async () => {
    const { presenter, vendor } = buildPresenter();

    const id = await presenter.sendQuestion(
      'chat-1',
      'Pick one?',
      options,
      'pq-1',
      'cid-ask-1',
      'status-42',
    );

    expect(id).toBe('status-42');
    expect(vendor.editMessageText).toHaveBeenCalledTimes(1);
    expect(vendor.sendActions).not.toHaveBeenCalled();
    expect(vendor.deleteMessage).not.toHaveBeenCalled();

    const [target, edit] = vendor.editMessageText.mock.calls[0];

    expect(target).toEqual({ vendorChatId: 'chat-1' });
    expect(edit.vendorMessageId).toBe('status-42');
    expect(edit.text).toBe('Pick one?');
    expect(edit.buttons).toEqual([
      [
        { label: 'Yes', callbackData: 'ask:pq-1:a' },
        { label: 'No', callbackData: 'ask:pq-1:b' },
      ],
    ]);
  });

  it('retires the stale status message and falls back to a fresh sendActions when the edit fails', async () => {
    const { presenter, vendor } = buildPresenter();

    vendor.editMessageText.mockRejectedValue(
      new Error('message to edit not found'),
    );

    const id = await presenter.sendQuestion(
      'chat-1',
      'Pick one?',
      options,
      'pq-1',
      'cid-ask-2',
      'status-42',
    );

    // Edit attempted once, then the stale status message is deleted...
    expect(vendor.editMessageText).toHaveBeenCalledTimes(1);
    expect(vendor.deleteMessage).toHaveBeenCalledWith(
      { vendorChatId: 'chat-1' },
      'status-42',
    );

    // ...and a fresh keyboard message carries the question instead.
    expect(vendor.sendActions).toHaveBeenCalledTimes(1);

    const [, actions] = vendor.sendActions.mock.calls[0];

    expect(actions.text).toBe('Pick one?');
    expect(actions.buttons).toEqual([
      [
        { label: 'Yes', callbackData: 'ask:pq-1:a' },
        { label: 'No', callbackData: 'ask:pq-1:b' },
      ],
    ]);

    // R3 / ADR 0058: the fresh-keyboard fallback now RETURNS its sendActions
    // message id (was null) so the answered-question morph can target it.
    expect(id).toBe('777');
  });

  it('returns the fresh sendActions id when there is NO status message to morph (no editMessageId)', async () => {
    const { presenter, vendor } = buildPresenter();

    const id = await presenter.sendQuestion(
      'chat-1',
      'Pick one?',
      options,
      'pq-1',
      'cid-ask-3',
    );

    // No morph attempted; a fresh keyboard carries the question and its id flows
    // back (R3 / ADR 0058 — Feature 1 works on the fresh-keyboard path too).
    expect(vendor.editMessageText).not.toHaveBeenCalled();
    expect(vendor.sendActions).toHaveBeenCalledTimes(1);
    expect(id).toBe('777');
  });

  it('returns null when the fresh sendActions itself fails', async () => {
    const { presenter, vendor } = buildPresenter();

    vendor.sendActions.mockRejectedValueOnce(new Error('blocked'));

    const id = await presenter.sendQuestion(
      'chat-1',
      'Pick one?',
      options,
      'pq-1',
      'cid-ask-4',
    );

    expect(id).toBeNull();
  });
});

describe('ReplyPresenter.markQuestionAnswered (R3 / ADR 0058 answered-question morph)', () => {
  it('edits the question message to question + localized "User selected" line and CLEARS the buttons', async () => {
    const { presenter, vendor } = buildPresenter();

    await presenter.markQuestionAnswered(
      'chat-1',
      'q-msg-7',
      'Which day?',
      'Friday',
      'en',
      'cid-mark-1',
    );

    expect(vendor.editMessageText).toHaveBeenCalledTimes(1);

    const [target, edit] = vendor.editMessageText.mock.calls[0];

    expect(target).toEqual({ vendorChatId: 'chat-1' });
    expect(edit).toEqual({
      vendorMessageId: 'q-msg-7',
      text: 'Which day?\n\nUser selected: Friday',
      format: OutboundFormat.Html,
      clearButtons: true,
    });
  });

  it('localizes the prefix per locale (ru / uk)', async () => {
    const { presenter, vendor } = buildPresenter();

    await presenter.markQuestionAnswered(
      'chat-1',
      'q-msg-7',
      'Когда?',
      'Пятница',
      'ru',
    );
    await presenter.markQuestionAnswered(
      'chat-1',
      'q-msg-8',
      'Коли?',
      'Пʼятниця',
      'uk',
    );

    expect(vendor.editMessageText.mock.calls[0][1].text).toBe(
      'Когда?\n\nВы выбрали: Пятница',
    );
    expect(vendor.editMessageText.mock.calls[1][1].text).toBe(
      'Коли?\n\nВи обрали: Пʼятниця',
    );
  });

  it('HTML-escapes both the question and the chosen label (untrusted < > &)', async () => {
    const { presenter, vendor } = buildPresenter();

    await presenter.markQuestionAnswered(
      'chat-1',
      'q-msg-9',
      'A <b> or B?',
      '<script>',
      'en',
    );

    const [, edit] = vendor.editMessageText.mock.calls[0];

    expect(edit.text).toBe(
      'A &lt;b&gt; or B?\n\nUser selected: &lt;script&gt;',
    );
  });

  it('degrades (never throws) when the edit fails', async () => {
    const { presenter, vendor } = buildPresenter();

    vendor.editMessageText.mockRejectedValueOnce(
      new Error('message to edit not found'),
    );

    await expect(
      presenter.markQuestionAnswered(
        'chat-1',
        'q-msg-7',
        'Which day?',
        'Friday',
        'en',
      ),
    ).resolves.toBeUndefined();
  });
});
