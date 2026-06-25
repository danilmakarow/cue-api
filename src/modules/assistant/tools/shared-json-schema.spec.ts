import { ZodType } from 'zod';

import { toolRegistry } from './tool-registry';
import { updateGroupInputSchema, updateTaskInputSchema } from './tool-schemas';
import { ToolSchema } from '@/modules/ai/ai.types';

/**
 * Regression guard for the root-cause class of bug this suite was created for: a
 * tool field whose Zod validator is `.nullable()` but whose model-facing JSON
 * schema is NOT nullable, so a schema-conforming model can never send the `null`
 * that clears the field. The model only ever sees the JSON schema, so the two
 * must agree on which fields accept `null`. We build the schemas exactly the way
 * `tool-registry`'s `toSchemas()` does (verbatim hand-written `jsonSchema` when a
 * tool supplies one) and assert that every Zod-nullable property is nullable in
 * the JSON schema too.
 */

/** A model-facing JSON-schema property fragment, as deep as we inspect here. */
type JsonSchemaProperty = {
  type?: string | string[];
  anyOf?: { type?: string | string[] }[];
};

/** The `properties` map of an object JSON schema, keyed by field name. */
type JsonSchemaProperties = Record<string, JsonSchemaProperty>;

/**
 * Builds the registry's derived `ToolSchema[]` the same way the orchestrator and
 * context builder consume it, then returns the one tool by name (throwing if it
 * is missing so a typo fails loudly rather than yielding `undefined`).
 */
const getDerivedSchema = async (toolName: string): Promise<ToolSchema> => {
  const schemas = await toolRegistry.toSchemas();
  const schema = schemas.find((candidate) => candidate.name === toolName);

  if (!schema) throw new Error(`No derived schema for tool "${toolName}".`);

  return schema;
};

/** Reads the `properties` map off a derived tool's object `inputSchema`. */
const propertiesOf = (schema: ToolSchema): JsonSchemaProperties =>
  (schema.inputSchema as { properties: JsonSchemaProperties }).properties;

/**
 * Whether a JSON-schema property admits `null` for the model. Accepts BOTH the
 * hand-written tuple form this codebase uses (`type: ['string', 'null']`) and the
 * `anyOf: [..., { type: 'null' }]` form a Zod-derived schema would emit, so the
 * guard holds regardless of how a future tool produces its `jsonSchema`.
 */
const jsonSchemaAdmitsNull = (property: JsonSchemaProperty): boolean => {
  if (Array.isArray(property.type)) return property.type.includes('null');

  if (property.type === 'null') return true;

  return (property.anyOf ?? []).some((member) =>
    Array.isArray(member.type)
      ? member.type.includes('null')
      : member.type === 'null',
  );
};

/**
 * Whether a Zod field accepts `null` (i.e. it was declared `.nullable()`).
 * `safeParse(null)` succeeds only for a nullable field — a plain `.optional()`
 * non-nullable field rejects `null` — so this is a validator-version-agnostic
 * read of the intended nullability, not a peek at private `_def` internals.
 */
const zodFieldAcceptsNull = (field: ZodType): boolean =>
  field.safeParse(null).success;

/** The shape (field name → field validator) of an object Zod schema. */
const shapeOf = (schema: ZodType): Record<string, ZodType> =>
  (schema as unknown as { shape: Record<string, ZodType> }).shape;

/**
 * The update tools under guard, paired with the Zod object schema that is their
 * single source of truth. Each row drives both the specific assertions and the
 * general parity loop below.
 */
const UPDATE_TOOLS: { name: string; zodSchema: ZodType }[] = [
  { name: 'update_task', zodSchema: updateTaskInputSchema },
  { name: 'update_group', zodSchema: updateGroupInputSchema },
];

describe('update tool JSON schemas — recurrence nullability', () => {
  it.each(UPDATE_TOOLS)(
    '$name exposes recurrence with type including "null" (matches its Zod .nullable())',
    async ({ name, zodSchema }) => {
      const properties = propertiesOf(await getDerivedSchema(name));
      const recurrence = properties.recurrence;

      // Sanity-check the Zod source of truth marks recurrence nullable...
      expect(zodFieldAcceptsNull(shapeOf(zodSchema).recurrence)).toBe(true);
      // ...and the model-facing schema agrees (this is the regression that bit).
      expect(jsonSchemaAdmitsNull(recurrence)).toBe(true);
      expect(recurrence.type).toEqual(['object', 'null']);
    },
  );
});

describe('update_task JSON schema — fields the model must be able to edit', () => {
  it('exposes notes, isAllDay, and timezone as editable properties', async () => {
    const properties = propertiesOf(await getDerivedSchema('update_task'));

    expect(properties.notes).toBeDefined();
    expect(properties.isAllDay).toBeDefined();
    expect(properties.timezone).toBeDefined();
    expect(properties.isAllDay.type).toBe('boolean');
    expect(properties.timezone.type).toBe('string');
  });

  it('makes startAt, group, and recurrence nullable in the JSON schema', async () => {
    const properties = propertiesOf(await getDerivedSchema('update_task'));

    expect(jsonSchemaAdmitsNull(properties.startAt)).toBe(true);
    expect(jsonSchemaAdmitsNull(properties.group)).toBe(true);
    expect(jsonSchemaAdmitsNull(properties.recurrence)).toBe(true);
    expect(properties.startAt.type).toEqual(['string', 'null']);
    expect(properties.group.type).toEqual(['string', 'null']);
  });
});

describe('update_group JSON schema — fields the model must be able to edit', () => {
  it('exposes sortOrder and makes recurrence nullable in the JSON schema', async () => {
    const properties = propertiesOf(await getDerivedSchema('update_group'));

    expect(properties.sortOrder).toBeDefined();
    expect(properties.sortOrder.type).toBe('integer');
    expect(jsonSchemaAdmitsNull(properties.recurrence)).toBe(true);
    expect(properties.recurrence.type).toEqual(['object', 'null']);
  });
});

describe('Zod ↔ JSON-schema nullability parity (single source-of-truth guard)', () => {
  it.each(UPDATE_TOOLS)(
    'every $name field marked .nullable() in Zod is nullable in the JSON schema',
    async ({ name, zodSchema }) => {
      const properties = propertiesOf(await getDerivedSchema(name));
      const shape = shapeOf(zodSchema);

      const nullableZodFields = Object.keys(shape).filter((fieldName) =>
        zodFieldAcceptsNull(shape[fieldName]),
      );

      // Guard the guard: if this list is ever empty the parity check is vacuous.
      expect(nullableZodFields.length).toBeGreaterThan(0);

      for (const fieldName of nullableZodFields) {
        const property = properties[fieldName];

        expect(property).toBeDefined();
        expect({
          field: fieldName,
          admitsNull: jsonSchemaAdmitsNull(property),
        }).toEqual({ field: fieldName, admitsNull: true });
      }
    },
  );
});
