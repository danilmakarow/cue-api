import { markdownToTelegramHtml } from './markdown-to-telegram-html';

describe('markdownToTelegramHtml (ADR 0049)', () => {
  it('renders **bold** as <b>', () => {
    expect(markdownToTelegramHtml('say **hello** now')).toBe(
      'say <b>hello</b> now',
    );
  });

  it('renders __bold__ as <b>', () => {
    expect(markdownToTelegramHtml('__strong__')).toBe('<b>strong</b>');
  });

  it('renders *italic* as <i>', () => {
    expect(markdownToTelegramHtml('an *emphasised* word')).toBe(
      'an <i>emphasised</i> word',
    );
  });

  it('renders _italic_ as <i>', () => {
    expect(markdownToTelegramHtml('_quiet_')).toBe('<i>quiet</i>');
  });

  it('renders `inline code` as <code> with its body escaped', () => {
    expect(markdownToTelegramHtml('use `a < b && c` here')).toBe(
      'use <code>a &lt; b &amp;&amp; c</code> here',
    );
  });

  it('does not parse Markdown inside an inline code span', () => {
    expect(markdownToTelegramHtml('`**not bold**`')).toBe(
      '<code>**not bold**</code>',
    );
  });

  it('renders a fenced code block as <pre> with its body escaped and literal', () => {
    const input = '```ts\nconst x = a < b && **y**;\n```';

    expect(markdownToTelegramHtml(input)).toBe(
      '<pre>const x = a &lt; b &amp;&amp; **y**;</pre>',
    );
  });

  it('renders a [label](url) link as an <a href>', () => {
    expect(markdownToTelegramHtml('see [Cue](https://cue.app)')).toBe(
      'see <a href="https://cue.app">Cue</a>',
    );
  });

  it('escapes the href in a link', () => {
    expect(markdownToTelegramHtml('[x](https://e.com/?a=1&b=2)')).toBe(
      '<a href="https://e.com/?a=1&amp;b=2">x</a>',
    );
  });

  it('renders an ATX heading as a bold line (Telegram has no heading tag)', () => {
    expect(markdownToTelegramHtml('# Today')).toBe('<b>Today</b>');
    expect(markdownToTelegramHtml('### Smaller')).toBe('<b>Smaller</b>');
  });

  it('renders bullet list items as plain • lines', () => {
    const input = '- first\n- second';

    expect(markdownToTelegramHtml(input)).toBe('• first\n• second');
  });

  it('renders ordered list items as plain numbered lines', () => {
    const input = '1. first\n2. second';

    expect(markdownToTelegramHtml(input)).toBe('1. first\n2. second');
  });

  it('renders a blockquote line in <blockquote>', () => {
    expect(markdownToTelegramHtml('> a quote')).toBe(
      '<blockquote>a quote</blockquote>',
    );
  });

  it('escapes < > & in otherwise-plain text', () => {
    expect(markdownToTelegramHtml('a < b > c & d')).toBe(
      'a &lt; b &gt; c &amp; d',
    );
  });

  it('leaves already-safe plain text unchanged', () => {
    const input = 'Done — added "buy milk" to your list.';

    expect(markdownToTelegramHtml(input)).toBe(input);
  });

  it('returns an empty string for empty input', () => {
    expect(markdownToTelegramHtml('')).toBe('');
  });

  it('renders multiple inline constructs on one line', () => {
    expect(markdownToTelegramHtml('**bold** and *italic* and `code`')).toBe(
      '<b>bold</b> and <i>italic</i> and <code>code</code>',
    );
  });

  it('renders bold inside a bullet item', () => {
    expect(markdownToTelegramHtml('- buy **milk**')).toBe('• buy <b>milk</b>');
  });

  it('renders inline marks inside a heading', () => {
    expect(markdownToTelegramHtml('## Plan for `today`')).toBe(
      '<b>Plan for <code>today</code></b>',
    );
  });

  it('preserves blank lines (paragraph spacing) between blocks', () => {
    const input = 'first paragraph\n\nsecond paragraph';

    expect(markdownToTelegramHtml(input)).toBe(
      'first paragraph\n\nsecond paragraph',
    );
  });

  it('keeps a fenced block literal while rendering surrounding Markdown', () => {
    const input = 'Run **this**:\n```\nnpm < test\n```\nthen *check*.';

    expect(markdownToTelegramHtml(input)).toBe(
      'Run <b>this</b>:\n<pre>npm &lt; test</pre>\nthen <i>check</i>.',
    );
  });
});
