import { PersonaSettingsService } from './persona-settings.service';
import { DEFAULT_PERSONA_TEXT } from './persona.constants';
import {
  PersonaPrompt,
  PersonaPromptSource,
} from '@/modules/database/entities';

/**
 * Builds a {@link PersonaSettingsService} over an in-memory persona store so each
 * test can assert the GET-resolves-active (custom → seeded preset → code default)
 * and PATCH-upserts behaviour. `findActivePersona` and `upsertCustomForUser`
 * mirror the real DB service contract.
 */
const buildHarness = (
  options: { seedPreset?: boolean } = { seedPreset: false },
) => {
  const customRows = new Map<string, PersonaPrompt>();

  const seededPreset: PersonaPrompt | null = options.seedPreset
    ? ({
        userId: null,
        presetName: 'Jarvis',
        promptText: 'SEEDED jarvis preset text',
        source: PersonaPromptSource.PRESET,
      } as PersonaPrompt)
    : null;

  const personaPromptDatabaseService = {
    findActivePersona: jest.fn(async (userId: string) => {
      return customRows.get(userId) ?? seededPreset;
    }),
    upsertCustomForUser: jest.fn(async (userId: string, promptText: string) => {
      const existing = customRows.get(userId);

      if (existing && existing.promptText === promptText) {
        return existing;
      }

      const row = {
        userId,
        presetName: null,
        promptText,
        source: PersonaPromptSource.CUSTOM,
      } as PersonaPrompt;

      customRows.set(userId, row);

      return row;
    }),
  };

  const service = new PersonaSettingsService(
    personaPromptDatabaseService as never,
  );

  return { service, personaPromptDatabaseService, customRows };
};

describe('PersonaSettingsService (Story 18 / ADR 0014)', () => {
  it('getActive returns the Jarvis code-constant default when the user has no persona AND no seed exists', async () => {
    const { service } = buildHarness({ seedPreset: false });

    const persona = await service.getActive('user-1');

    expect(persona.source).toBe(PersonaPromptSource.PRESET);
    expect(persona.presetName).toBe('Jarvis');
    expect(persona.promptText).toBe(DEFAULT_PERSONA_TEXT);
    // The default text is the dry English-butler Jarvis persona.
    expect(persona.promptText).toContain('J.A.R.V.I.S.');
  });

  it('getActive returns the seeded preset when present and the user has no custom persona', async () => {
    const { service } = buildHarness({ seedPreset: true });

    const persona = await service.getActive('user-1');

    expect(persona.source).toBe(PersonaPromptSource.PRESET);
    expect(persona.promptText).toBe('SEEDED jarvis preset text');
  });

  it('getActive returns the user own custom persona once set', async () => {
    const { service } = buildHarness({ seedPreset: true });

    await service.update('user-1', { promptText: 'my own butler' });

    const persona = await service.getActive('user-1');

    expect(persona.source).toBe(PersonaPromptSource.CUSTOM);
    expect(persona.promptText).toBe('my own butler');
  });

  it('update upserts the custom persona text and returns the persisted CUSTOM row', async () => {
    const { service, personaPromptDatabaseService } = buildHarness();

    const updated = await service.update('user-1', {
      promptText: 'a brisk quartermaster',
    });

    expect(updated.source).toBe(PersonaPromptSource.CUSTOM);
    expect(updated.promptText).toBe('a brisk quartermaster');
    expect(
      personaPromptDatabaseService.upsertCustomForUser,
    ).toHaveBeenCalledWith('user-1', 'a brisk quartermaster');
  });
});
