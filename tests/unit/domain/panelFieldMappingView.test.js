import { toFieldMappingView } from '../../../src/domain/panel/fieldMappingView.js';

const RAW = {
  _id: { toString: () => '6a6b94a1cd7c01b21aa58c41' },
  sourceField: 'QuantityOnStock',
  targetField: 'quantity',
  objectType: 'product',
  sourceContext: 'product',
  isActive: true,
  editable: false,
  includeInServiceLayerSelect: false,
  userField: false,
  clientConfigId: '6a6b94a1cd7c01b21aa58c99',
  hubspotCredentialId: '6a6b94a1cd7c01b21aa58c98',
  __v: 0,
};

describe('field mapping view (plan 6, I2)', () => {
  it('maps every field with the generic name and the id as text', () => {
    expect(toFieldMappingView(RAW)).toEqual({
      id: '6a6b94a1cd7c01b21aa58c41',
      sourceField: 'QuantityOnStock',
      targetField: 'quantity',
      objectType: 'product',
      sourceContext: 'product',
      isActive: true,
      editable: false,
      includeInSourceQuery: false,
      userField: false,
    });
  });

  it('never exposes internal fields, even when the document has them', () => {
    const view = toFieldMappingView(RAW);

    expect(view).not.toHaveProperty('clientConfigId');
    expect(view).not.toHaveProperty('hubspotCredentialId');
    expect(view).not.toHaveProperty('includeInServiceLayerSelect');
    expect(view).not.toHaveProperty('__v');
    expect(Object.keys(view)).toHaveLength(9);
  });

  it('turns missing or empty texts into null', () => {
    const view = toFieldMappingView({ _id: 'x', sourceField: '', sourceContext: '', targetField: null });

    expect(view).toEqual(expect.objectContaining({
      sourceField: null,
      targetField: null,
      objectType: null,
      sourceContext: null,
    }));
  });

  it('uses the schema defaults for missing flags, like the integration does', () => {
    expect(toFieldMappingView({ _id: 'x' })).toEqual(expect.objectContaining({
      isActive: true,
      editable: true,
      includeInSourceQuery: true,
      userField: false,
    }));
  });

  it('keeps stored flags as they are', () => {
    expect(toFieldMappingView({ _id: 'x', isActive: false, editable: false, includeInServiceLayerSelect: false, userField: true }))
      .toEqual(expect.objectContaining({ isActive: false, editable: false, includeInSourceQuery: false, userField: true }));
  });

  it('returns null without a document', () => {
    expect(toFieldMappingView(null)).toBeNull();
  });
});
