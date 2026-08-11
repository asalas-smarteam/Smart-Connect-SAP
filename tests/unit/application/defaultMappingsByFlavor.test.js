import { jest } from '@jest/globals';
import {
  ensureDefaultCompanyEmployeeMappings,
  ensureDefaultContactEmployeeMappings,
  ensureDefaultDealMappings,
  ensureDefaultProductMappings,
} from '../../../src/application/services/defaultClientConfigMappings.service.js';

// Fake FieldMapping model that enforces the same unique index Mongo does
// (hubspotCredentialId + objectType + sourceContext + sourceField).
function buildFieldMapping() {
  const rows = [];
  const index = new Set();

  return {
    rows,
    async findOne(filter) {
      return rows.find((row) => row.objectType === filter.objectType
        && row.sourceContext === filter.sourceContext
        && row.sourceField === filter.sourceField
        && row.targetField === filter.targetField) || null;
    },
    async create(doc) {
      const key = `${doc.objectType}|${doc.sourceContext}|${doc.sourceField}`;
      if (index.has(key)) {
        const error = new Error(`E11000 duplicate key: ${key}`);
        error.code = 11000;
        throw error;
      }
      index.add(key);
      rows.push(doc);
      return doc;
    },
    updateOne: jest.fn(),
  };
}

const companyConfig = { _id: 'c1', hubspotCredentialId: 'cred-1', objectType: 'company' };
const productConfig = { _id: 'c2', hubspotCredentialId: 'cred-1', objectType: 'product' };
const dealConfig = { _id: 'c3', hubspotCredentialId: 'cred-1', objectType: 'deal' };
const contactConfig = { _id: 'c4', hubspotCredentialId: 'cred-1', objectType: 'contact' };

describe('default mappings by SAP flavor', () => {
  describe('B1 (unchanged behavior)', () => {
    it('seeds the historical company + contact mappings', async () => {
      const FieldMapping = buildFieldMapping();

      await ensureDefaultCompanyEmployeeMappings({ FieldMapping, clientConfig: companyConfig });
      await ensureDefaultContactEmployeeMappings({ FieldMapping, clientConfig: companyConfig });

      const sources = FieldMapping.rows.map((row) => row.sourceField);
      expect(sources).toContain('CardCode');
      expect(sources).toContain('CardName');
      expect(FieldMapping.rows.filter((r) => r.objectType === 'company')).toHaveLength(5);
      expect(FieldMapping.rows.filter((r) => r.objectType === 'contact')).toHaveLength(10);
    });

    it('defaults to B1 when no flavor is provided', async () => {
      const FieldMapping = buildFieldMapping();
      await ensureDefaultProductMappings({ FieldMapping, clientConfig: productConfig });

      expect(FieldMapping.rows.map((r) => r.sourceField)).toEqual(
        expect.arrayContaining(['ItemCode', 'ItemName'])
      );
    });
  });

  describe('S4', () => {
    it('seeds S/4 company mappings with navigation paths', async () => {
      const FieldMapping = buildFieldMapping();

      await ensureDefaultCompanyEmployeeMappings({
        FieldMapping,
        clientConfig: companyConfig,
        sapFlavor: 'S4',
      });

      const byTarget = Object.fromEntries(
        FieldMapping.rows.map((row) => [row.targetField, row.sourceField])
      );

      expect(byTarget).toEqual({
        idsap: 'BusinessPartner',
        name: 'BusinessPartnerFullName',
        tipo_cliente: 'BusinessPartnerGrouping',
        cedula: 'to_Customer.TaxNumber1',
        email: 'to_BusinessPartnerAddress.to_EmailAddress.EmailAddress',
        phone: 'to_BusinessPartnerAddress.to_PhoneNumber.PhoneNumber',
        city: 'to_BusinessPartnerAddress.CityName',
        country: 'to_BusinessPartnerAddress.Country',
      });
      expect(FieldMapping.rows.every((row) => row.objectType === 'company')).toBe(true);
    });

    it('seeds S/4 contact mappings under the contact config (person-BP shape)', async () => {
      const FieldMapping = buildFieldMapping();

      await ensureDefaultContactEmployeeMappings({
        FieldMapping,
        clientConfig: contactConfig,
        sapFlavor: 'S4',
      });

      const byTarget = Object.fromEntries(
        FieldMapping.rows.map((row) => [row.targetField, row.sourceField])
      );
      expect(byTarget).toEqual({
        internalcode: 'BusinessPartner',
        firstname: 'FirstName',
        lastname: 'LastName',
        email: 'to_BusinessPartnerAddress.to_EmailAddress.EmailAddress',
        phone: 'to_BusinessPartnerAddress.to_PhoneNumber.PhoneNumber',
      });
      expect(FieldMapping.rows.every((row) => row.objectType === 'contact')).toBe(true);
      expect(FieldMapping.rows.every((row) => row.sourceContext === 'contactEmployee')).toBe(true);
    });

    it('identifies S/4 company contacts by internalcode, like B1 does', async () => {
      const FieldMapping = buildFieldMapping();

      await ensureDefaultContactEmployeeMappings({
        FieldMapping,
        clientConfig: contactConfig,
        sapFlavor: 'S4',
      });

      const identity = FieldMapping.rows.filter(
        (m) => m.sourceContext === 'contactEmployee' && m.targetField === 'internalcode'
      );

      expect(identity).toHaveLength(1);
      expect(identity[0].sourceField).toBe('BusinessPartner');
      expect(FieldMapping.rows.some(
        (m) => m.sourceContext === 'contactEmployee' && m.targetField === 'idsap'
      )).toBe(false);
    });

    it('does not seed S/4 contact mappings under a company config', async () => {
      const FieldMapping = buildFieldMapping();

      await ensureDefaultContactEmployeeMappings({
        FieldMapping,
        clientConfig: companyConfig,
        sapFlavor: 'S4',
      });

      expect(FieldMapping.rows).toHaveLength(0);
    });

    it('does not seed S/4 product mappings: they are DB-only for this flavor', async () => {
      const FieldMapping = buildFieldMapping();

      await ensureDefaultProductMappings({
        FieldMapping,
        clientConfig: productConfig,
        sapFlavor: 'S4',
      });

      expect(FieldMapping.rows).toHaveLength(0);
    });

    it('seeds no deal mappings for S/4 until A_SalesOrder is profiled', async () => {
      const FieldMapping = buildFieldMapping();

      await ensureDefaultDealMappings({
        FieldMapping,
        clientConfig: dealConfig,
        sapFlavor: 'S4',
      });

      expect(FieldMapping.rows).toHaveLength(0);
    });
  });

  it('B1 does not seed contact mappings under a contact config (unchanged)', async () => {
    const FieldMapping = buildFieldMapping();

    await ensureDefaultContactEmployeeMappings({
      FieldMapping,
      clientConfig: contactConfig,
    });

    expect(FieldMapping.rows).toHaveLength(0);
  });

  it('no flavor collides with the unique index', async () => {
    for (const sapFlavor of ['B1', 'S4']) {
      const FieldMapping = buildFieldMapping();
      await expect(Promise.all([
        ensureDefaultCompanyEmployeeMappings({ FieldMapping, clientConfig: companyConfig, sapFlavor }),
        ensureDefaultContactEmployeeMappings({ FieldMapping, clientConfig: companyConfig, sapFlavor }),
      ])).resolves.not.toThrow();

      const contactMapping = buildFieldMapping();
      await expect(
        ensureDefaultContactEmployeeMappings({ FieldMapping: contactMapping, clientConfig: contactConfig, sapFlavor })
      ).resolves.not.toThrow();

      const productMapping = buildFieldMapping();
      await expect(
        ensureDefaultProductMappings({ FieldMapping: productMapping, clientConfig: productConfig, sapFlavor })
      ).resolves.not.toThrow();

      const dealMapping = buildFieldMapping();
      await expect(
        ensureDefaultDealMappings({ FieldMapping: dealMapping, clientConfig: dealConfig, sapFlavor })
      ).resolves.not.toThrow();
    }
  });
});
