import {
  SECRET_MASK,
  dropMaskedSecrets,
  maskSecretFields,
} from '../../../src/application/services/secret-fields.service.js';

describe('secret-fields.service', () => {
  describe('maskSecretFields', () => {
    it('replaces a stored secret with the mask and an empty one with null', () => {
      const masked = maskSecretFields(
        { clientName: 'Obtener Clientes', apiToken: 'real-token', externalDbPassword: '' },
        ['apiToken', 'externalDbPassword']
      );

      expect(masked).toEqual({
        clientName: 'Obtener Clientes',
        apiToken: SECRET_MASK,
        externalDbPassword: null,
      });
    });

    it('leaves absent secret fields absent', () => {
      expect(maskSecretFields({ clientName: 'x' }, ['apiToken'])).toEqual({ clientName: 'x' });
    });

    it('serializes a mongoose document through toJSON without touching it', () => {
      const doc = {
        apiToken: 'real-token',
        toJSON() {
          return { _id: 'cfg-1', apiToken: this.apiToken };
        },
      };

      const masked = maskSecretFields(doc, ['apiToken']);

      expect(masked).toEqual({ _id: 'cfg-1', apiToken: SECRET_MASK });
      expect(doc.apiToken).toBe('real-token');
    });

    it('does not mutate a plain object', () => {
      const record = { apiToken: 'real-token' };

      maskSecretFields(record, ['apiToken']);

      expect(record.apiToken).toBe('real-token');
    });

    it('passes null through', () => {
      expect(maskSecretFields(null, ['apiToken'])).toBeNull();
    });
  });

  describe('dropMaskedSecrets', () => {
    it('drops secret fields that still carry the mask so they keep their stored value', () => {
      expect(
        dropMaskedSecrets(
          { clientName: 'x', apiToken: SECRET_MASK, externalDbPassword: 'new-password' },
          ['apiToken', 'externalDbPassword']
        )
      ).toEqual({ clientName: 'x', externalDbPassword: 'new-password' });
    });

    it('keeps an explicit empty value so a secret can still be cleared on purpose', () => {
      expect(dropMaskedSecrets({ apiToken: '' }, ['apiToken'])).toEqual({ apiToken: '' });
    });

    it('only inspects the listed secret fields', () => {
      expect(dropMaskedSecrets({ clientName: SECRET_MASK }, ['apiToken'])).toEqual({
        clientName: SECRET_MASK,
      });
    });
  });
});
