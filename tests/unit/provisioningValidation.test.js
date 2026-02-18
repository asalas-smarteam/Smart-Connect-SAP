import {
  sanitizeMongoCollectionName,
  validateProvisioningPayload,
} from '../../src/utils/provisioningValidation.js';

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
    });
  });

  it('rejects payloads that cannot produce a valid collection name', () => {
    const result = validateProvisioningPayload({ nombreEmpresa: '!!!' });

    expect(result).toEqual({
      valid: false,
      error: 'nombreEmpresa must yield a valid MongoDB collection name',
    });
  });
});
