import { describe, expect, it } from '@jest/globals';
import {
  applyDynamicDescription,
  getDynamicDescriptionSourceFields,
  normalizeDynamicDescriptionConfig,
  renderTemplate,
  withDynamicDescriptionSelectFields,
} from '#domain/sync/dynamic-description.service.js';

function resolveField(record, sourceField) {
  return String(sourceField)
    .split('.')
    .reduce((current, segment) => (current == null ? null : current[segment]), record) ?? null;
}

const PRODUCT_CONFIG = {
  isRequired: true,
  regex: '${ItemName} - ${U_ACO_IdAdicional}',
};

describe('normalizeDynamicDescriptionConfig', () => {
  it('turns the flat { isRequired, regex } document into a product name rule', () => {
    const config = normalizeDynamicDescriptionConfig(PRODUCT_CONFIG);

    expect(config.isRequired).toBe(true);
    expect(config.rules).toEqual([
      {
        objectType: 'product',
        sourceContext: 'product',
        targetField: 'name',
        template: '${ItemName} - ${U_ACO_IdAdicional}',
        sourceFields: ['ItemName', 'U_ACO_IdAdicional'],
      },
    ]);
  });

  it('accepts an explicit rules array targeting another object and property', () => {
    const config = normalizeDynamicDescriptionConfig({
      isRequired: true,
      rules: [
        {
          objectType: 'company',
          sourceContext: 'businessPartner',
          targetField: 'name',
          regex: '${CardName} (${CardCode})',
        },
      ],
    });

    expect(config.rules).toHaveLength(1);
    expect(config.rules[0].objectType).toBe('company');
    expect(config.rules[0].targetField).toBe('name');
  });

  it('parses a JSON string value', () => {
    const config = normalizeDynamicDescriptionConfig(JSON.stringify(PRODUCT_CONFIG));

    expect(config.isRequired).toBe(true);
    expect(config.rules[0].sourceFields).toEqual(['ItemName', 'U_ACO_IdAdicional']);
  });

  it('is disabled for empty, malformed or template-less values', () => {
    expect(normalizeDynamicDescriptionConfig(null)).toEqual({ isRequired: false, rules: [] });
    expect(normalizeDynamicDescriptionConfig('not json')).toEqual({ isRequired: false, rules: [] });
    expect(normalizeDynamicDescriptionConfig({ isRequired: true })).toEqual({ isRequired: false, rules: [] });
    // A template with no placeholder would just hardcode a constant name.
    expect(normalizeDynamicDescriptionConfig({ isRequired: true, regex: 'plain text' }))
      .toEqual({ isRequired: false, rules: [] });
  });

  it('honours an explicit isRequired: false but defaults to on when the flag is absent', () => {
    expect(normalizeDynamicDescriptionConfig({ isRequired: false, regex: '${A} ${B}' }).isRequired)
      .toBe(false);
    expect(normalizeDynamicDescriptionConfig({ regex: '${A} ${B}' }).isRequired).toBe(true);
  });
});

describe('renderTemplate', () => {
  const values = { A: 'uno', B: 'dos', C: 'tres', empty: '', nullish: null };
  const resolve = (field) => values[field];

  it('concatenates every placeholder with its literals', () => {
    expect(renderTemplate('${A} - ${B}', resolve)).toBe('uno - dos');
  });

  it('drops an empty placeholder together with its leading separator', () => {
    expect(renderTemplate('${A} - ${empty}', resolve)).toBe('uno');
    expect(renderTemplate('${A} - ${nullish}', resolve)).toBe('uno');
    expect(renderTemplate('${A} - ${missing}', resolve)).toBe('uno');
  });

  it('drops a trailing literal that decorated an empty placeholder', () => {
    expect(renderTemplate('${A} (${empty})', resolve)).toBe('uno');
  });

  it('keeps the surrounding fields joined when a middle placeholder is empty', () => {
    expect(renderTemplate('${A} - ${empty} - ${C}', resolve)).toBe('uno - tres');
  });

  it('strips a dangling separator when the first placeholder is empty', () => {
    expect(renderTemplate('${empty} - ${B}', resolve)).toBe('dos');
  });

  it('keeps literal prefixes and suffixes when everything resolves', () => {
    expect(renderTemplate('SKU ${A} / ${B} ud.', resolve)).toBe('SKU uno / dos ud.');
  });

  it('returns null when nothing resolves so the caller keeps the 1:1 value', () => {
    expect(renderTemplate('${empty} - ${nullish}', resolve)).toBeNull();
    expect(renderTemplate('', resolve)).toBeNull();
  });

  it('renders numbers and booleans but not objects', () => {
    expect(renderTemplate('${n} - ${b}', (f) => ({ n: 0, b: false }[f]))).toBe('0 - false');
    expect(renderTemplate('${A} - ${o}', (f) => ({ A: 'uno', o: { deep: 1 } }[f]))).toBe('uno');
  });
});

describe('applyDynamicDescription', () => {
  it('overwrites the 1:1 mapped product name with the composed value', () => {
    const properties = { hs_sku: 'A100', name: 'Tornillo' };

    applyDynamicDescription({
      properties,
      record: { ItemName: 'Tornillo', U_ACO_IdAdicional: 'ADIC-7' },
      objectType: 'product',
      sourceContext: 'product',
      config: PRODUCT_CONFIG,
      resolveField,
    });

    expect(properties).toEqual({ hs_sku: 'A100', name: 'Tornillo - ADIC-7' });
  });

  it('leaves the mapped value untouched when the config is off or absent', () => {
    const properties = { name: 'Tornillo' };

    applyDynamicDescription({
      properties,
      record: { ItemName: 'Tornillo', U_ACO_IdAdicional: 'ADIC-7' },
      objectType: 'product',
      sourceContext: 'product',
      config: { ...PRODUCT_CONFIG, isRequired: false },
      resolveField,
    });
    applyDynamicDescription({
      properties,
      record: {},
      objectType: 'product',
      sourceContext: 'product',
      config: null,
      resolveField,
    });

    expect(properties.name).toBe('Tornillo');
  });

  it('does not apply a product rule to a company record', () => {
    const properties = { name: 'ACME' };

    applyDynamicDescription({
      properties,
      record: { ItemName: 'Tornillo', U_ACO_IdAdicional: 'ADIC-7' },
      objectType: 'company',
      sourceContext: 'businessPartner',
      config: PRODUCT_CONFIG,
      resolveField,
    });

    expect(properties.name).toBe('ACME');
  });

  it('supports dotted S/4 paths inside the template', () => {
    const properties = {};

    applyDynamicDescription({
      properties,
      record: { to_Description: { ProductDescription: 'Bomba' }, YY1_Extra: 'X1' },
      objectType: 'product',
      sourceContext: 'product',
      config: { isRequired: true, regex: '${to_Description.ProductDescription} - ${YY1_Extra}' },
      resolveField,
    });

    expect(properties.name).toBe('Bomba - X1');
  });

  it('keeps the mapped value when every placeholder is empty in SAP', () => {
    const properties = { name: 'Tornillo' };

    applyDynamicDescription({
      properties,
      record: { ItemName: null, U_ACO_IdAdicional: '' },
      objectType: 'product',
      sourceContext: 'product',
      config: PRODUCT_CONFIG,
      resolveField,
    });

    expect(properties.name).toBe('Tornillo');
  });
});

describe('withDynamicDescriptionSelectFields', () => {
  const mappings = [
    { sourceField: 'ItemCode', targetField: 'hs_sku', includeInServiceLayerSelect: true },
    { sourceField: 'ItemName', targetField: 'name', includeInServiceLayerSelect: true },
  ];

  it('appends only the template fields missing from the $select', () => {
    const widened = withDynamicDescriptionSelectFields(mappings, PRODUCT_CONFIG, {
      objectType: 'product',
      sourceContext: 'product',
    });

    expect(widened).toHaveLength(3);
    expect(widened[2]).toMatchObject({
      sourceField: 'U_ACO_IdAdicional',
      targetField: null,
      includeInServiceLayerSelect: true,
    });
  });

  it('returns the original array when the config is off or fully covered', () => {
    expect(withDynamicDescriptionSelectFields(mappings, null, { objectType: 'product' }))
      .toBe(mappings);
    expect(
      withDynamicDescriptionSelectFields(mappings, { isRequired: true, regex: '${ItemCode} ${ItemName}' }, {
        objectType: 'product',
        sourceContext: 'product',
      })
    ).toBe(mappings);
  });

  it('re-adds a field whose only mapping row is excluded from the $select', () => {
    const excluded = [
      ...mappings,
      { sourceField: 'U_ACO_IdAdicional', targetField: 'extra', includeInServiceLayerSelect: false },
    ];

    const widened = withDynamicDescriptionSelectFields(excluded, PRODUCT_CONFIG, {
      objectType: 'product',
      sourceContext: 'product',
    });

    expect(widened).toHaveLength(4);
    expect(widened[3].sourceField).toBe('U_ACO_IdAdicional');
  });
});

describe('getDynamicDescriptionSourceFields', () => {
  it('returns nothing when the rule targets another object type', () => {
    expect(getDynamicDescriptionSourceFields(PRODUCT_CONFIG, { objectType: 'company' })).toEqual([]);
  });

  it('returns the deduplicated fields of the matching rules', () => {
    expect(
      getDynamicDescriptionSourceFields(PRODUCT_CONFIG, {
        objectType: 'product',
        sourceContext: 'product',
      })
    ).toEqual(['ItemName', 'U_ACO_IdAdicional']);
  });
});
