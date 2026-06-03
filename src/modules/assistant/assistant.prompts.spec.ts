import { ASSISTANT_SYSTEM_PROMPT } from './assistant.prompts';

describe('ASSISTANT_SYSTEM_PROMPT', () => {
  it('keeps the J.A.R.V.I.S. persona', () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toMatch(/J\.A\.R\.V\.I\.S\./);
    expect(ASSISTANT_SYSTEM_PROMPT).toMatch(/Working with the calendar/);
  });

  it('teaches the bracketed-handle addressing and re-list-to-bring-into-view rule', () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toMatch(/\[e2\]/);
    expect(ASSISTANT_SYSTEM_PROMPT).toMatch(/bracketed handle/i);
    expect(ASSISTANT_SYSTEM_PROMPT).toMatch(/list_tasks/);
    expect(ASSISTANT_SYSTEM_PROMPT).toMatch(/not currently shown/i);
  });

  it('teaches one-task-with-a-recurrence, never copies for future dates', () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toMatch(/recurrence/i);
    expect(ASSISTANT_SYSTEM_PROMPT).toMatch(/never create separate copies/i);
  });

  it('teaches that todos (no time) are first-class', () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toMatch(/todos/i);
    expect(ASSISTANT_SYSTEM_PROMPT).toMatch(/no startAt|no time/i);
  });

  it('teaches the editScope ask for ambiguous recurring edits', () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toMatch(/editScope/);
    expect(ASSISTANT_SYSTEM_PROMPT).toMatch(
      /just this one, this and future, or all/i,
    );
  });

  it('teaches assigning a group by name and confirming before create_group', () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toMatch(/Groups line/i);
    expect(ASSISTANT_SYSTEM_PROMPT).toMatch(/create_group/);
  });
});
