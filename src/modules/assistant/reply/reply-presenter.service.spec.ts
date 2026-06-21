import { ReplyPresenter } from './reply-presenter.service';
import { OutboundFormat } from '@/modules/external-vendor/external-vendor.types';

/** Builds a vendor connector fake covering the send surface ReplyPresenter uses. */
const buildVendor = () => ({
  sendMessage: jest.fn().mockResolvedValue({ vendorMessageId: '555' }),
  sendActions: jest.fn().mockResolvedValue({ vendorMessageId: '777' }),
  sendMessageWithKeyboard: jest
    .fn()
    .mockResolvedValue({ vendorMessageId: '888' }),
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
