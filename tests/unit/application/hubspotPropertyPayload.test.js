import { sanitizeProperties } from '../../../src/application/services/hubspotPropertyPayload.service.js';

describe('sanitizeProperties', () => {
  it('drops properties the portal does not accept', () => {
    const allowed = new Set(['name', 'idsap']);
    expect(sanitizeProperties({ name: 'Acme', idsap: 'C001', inventada: 'x' }, allowed))
      .toEqual({ name: 'Acme', idsap: 'C001' });
  });

  it('drops null and undefined values that unresolved mappings produce', () => {
    const allowed = new Set(['name', 'idsap', 'email']);
    expect(sanitizeProperties({ name: 'Acme', idsap: null, email: undefined }, allowed))
      .toEqual({ name: 'Acme' });
  });

  it('keeps empty strings and zero, which are real values', () => {
    const allowed = new Set(['email', 'quantity']);
    expect(sanitizeProperties({ email: '', quantity: 0 }, allowed))
      .toEqual({ email: '', quantity: 0 });
  });

  it('keeps every non-null property when no allow list is given', () => {
    expect(sanitizeProperties({ a: 1, b: null, c: 'x' }))
      .toEqual({ a: 1, c: 'x' });
  });

  it('does not mutate the input and tolerates missing input', () => {
    const input = { name: 'Acme', bad: null };
    sanitizeProperties(input, new Set(['name']));
    expect(input).toEqual({ name: 'Acme', bad: null });
    expect(sanitizeProperties(null)).toEqual({});
  });
});
