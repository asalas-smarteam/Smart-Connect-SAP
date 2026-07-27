import {
  sanitizeMongoCollectionName,
  validateProvisioningPayload,
} from '../../src/shared/utils/provisioningValidation.js';

describe('provisioningValidation', () => {
  it('sanitizes collection names by normalizing casing and separators', () => {
    expect(sanitizeMongoCollectionName('  Acme Inc  ')).toBe('acme_inc');
    expect(sanitizeMongoCollectionName('Acme@@Inc!!2024')).toBe('acme_inc_2024');
  });

  it('validates and normalizes nombreEmpresa', () => {
    const result = validateProvisioningPayload({ nombreEmpresa: '  Acme Inc  ' });

    expect(result).toEqual({
      valid: true,
      normalizedCompanyName: 'Acme Inc',
      sanitizedCollectionName: 'acme_inc',
      normalizedSapFlavor: 'B1',
    });
  });

  it('rejects payloads that cannot produce a valid collection name', () => {
    const result = validateProvisioningPayload({ nombreEmpresa: '!!!' });

    expect(result).toEqual({
      valid: false,
      error: 'nombreEmpresa must yield a valid MongoDB collection name',
    });
  });

  it('defaults sapFlavor to B1 when absent', () => {
    const result = validateProvisioningPayload({ nombreEmpresa: 'Acme Inc' });

    expect(result.valid).toBe(true);
    expect(result.normalizedSapFlavor).toBe('B1');
  });

  it('normalizes sapFlavor casing and whitespace', () => {
    const result = validateProvisioningPayload({
      nombreEmpresa: 'Acme Inc',
      sapFlavor: '  s4  ',
    });

    expect(result.valid).toBe(true);
    expect(result.normalizedSapFlavor).toBe('S4');
  });

  it('rejects unknown sapFlavor values', () => {
    const result = validateProvisioningPayload({
      nombreEmpresa: 'Acme Inc',
      sapFlavor: 'HANA',
    });

    expect(result).toEqual({
      valid: false,
      error: 'sapFlavor must be one of: B1, S4',
    });
  });
});
