import { genericSource, toOwnerMappingView } from '../../../src/domain/panel/ownerMappingView.js';
import { OWNER_IDS as O, sampleOwnerMappings } from '../application/panel/operationFakes.js';

const [erick, ana, legacy] = sampleOwnerMappings().sap_integration_acme;

describe('owner mapping view (plan 11, N2)', () => {
  it('renames the fields and keeps the values as stored', () => {
    expect(toOwnerMappingView(erick)).toEqual({
      id: O.erick,
      crmOwnerId: '82929225',
      crmOwnerName: 'Erick Figueroa',
      crmOwnerEmail: 'ventas8@acme.test',
      erpOwnerId: '53',
      erpOwnerName: null,
      erpEmployeeId: '67',
      active: true,
      source: 'crm_seed',
      createdAt: '2026-07-03T02:03:51.125Z',
      updatedAt: '2026-07-03T02:03:51.125Z',
    });
  });

  it('keeps several ERP codes and inactive records as they are', () => {
    expect(toOwnerMappingView(ana)).toEqual(expect.objectContaining({
      erpOwnerId: '113,758,864',
      active: false,
      source: 'manual',
    }));
  });

  it('never exposes internal fields', () => {
    const view = toOwnerMappingView(erick);

    expect(view).not.toHaveProperty('hubspotCredentialId');
    expect(view).not.toHaveProperty('__v');
    expect(JSON.stringify(Object.keys(view))).not.toMatch(/hubspot|sap/i);
  });

  it('sends null for missing fields and keeps a stored number', () => {
    expect(toOwnerMappingView(legacy)).toEqual({
      id: O.legacy,
      crmOwnerId: '12345',
      crmOwnerName: null,
      crmOwnerEmail: null,
      erpOwnerId: 7,
      erpOwnerName: null,
      erpEmployeeId: null,
      active: null,
      source: null,
      createdAt: null,
      updatedAt: null,
    });
  });

  it.each([
    ['hubspot_seed', 'crm_seed'],
    ['manual', 'manual'],
    ['sap_import', 'erp_import'],
    [null, null],
  ])('maps source %p to %p', (input, expected) => {
    expect(genericSource(input)).toBe(expected);
  });
});
