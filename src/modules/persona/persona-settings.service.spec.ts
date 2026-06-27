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

  const presetRows: PersonaPrompt[] = seededPreset ? [seededPreset] : [];

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
    // Stands in for the base service's `findAllBy({ userId: IsNull(), source:
    // PRESET })` — returns the seeded preset rows only.
    findAllBy: jest.fn(async () => presetRows),
    // Stands in for the base service's `delete({ userId, source: CUSTOM })`.
    delete: jest.fn(async (where: { userId: string }) => {
      const had = customRows.delete(where.userId);

      return { affected: had ? 1 : 0, raw: [] };
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

  it('listPresets returns the seeded curated presets (D9)', async () => {
    const { service } = buildHarness({ seedPreset: true });

    const presets = await service.listPresets();

    expect(presets).toHaveLength(1);
    expect(presets[0].source).toBe(PersonaPromptSource.PRESET);
    expect(presets[0].presetName).toBe('Jarvis');
  });

  it('listPresets returns an empty list when no preset is seeded (D9)', async () => {
    const { service } = buildHarness({ seedPreset: false });

    const presets = await service.listPresets();

    expect(presets).toEqual([]);
  });

  it('clearCustom removes the user custom persona and falls back to the seeded preset (D9)', async () => {
    const { service, personaPromptDatabaseService } = buildHarness({
      seedPreset: true,
    });

    await service.update('user-1', { promptText: 'my own butler' });

    const active = await service.clearCustom('user-1');

    expect(personaPromptDatabaseService.delete).toHaveBeenCalledWith({
      userId: 'user-1',
      source: PersonaPromptSource.CUSTOM,
    });
    // After the reset the active persona is the seeded preset again.
    expect(active.source).toBe(PersonaPromptSource.PRESET);
    expect(active.promptText).toBe('SEEDED jarvis preset text');
  });

  it('clearCustom is idempotent — returns the fallback even with no custom persona set (D9)', async () => {
    const { service } = buildHarness({ seedPreset: false });

    const active = await service.clearCustom('user-1');

    // No custom row, no seed → the code-constant Jarvis default.
    expect(active.source).toBe(PersonaPromptSource.PRESET);
    expect(active.promptText).toBe(DEFAULT_PERSONA_TEXT);
  });
});
