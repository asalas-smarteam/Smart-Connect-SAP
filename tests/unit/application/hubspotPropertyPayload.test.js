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

  it('drops associations and hs_object_id even when the allow list carries them', () => {
    const allowed = new Set(['name', 'associations', 'hs_object_id']);
    expect(sanitizeProperties(
      { name: 'Acme', associations: { companies: ['C001'] }, hs_object_id: '123' },
      allowed
    )).toEqual({ name: 'Acme' });
  });

  it('drops associations and hs_object_id when there is no allow list', () => {
    // The null-allow-list path is the soft-failed catalog lookup: a real
    // `properties.associations` object would 400 the whole chunk.
    expect(sanitizeProperties({
      name: 'Acme',
      associations: { companies: ['C001'] },
      hs_object_id: '123',
    })).toEqual({ name: 'Acme' });
  });

  it('drops nested objects and arrays, which HubSpot cannot store', () => {
    expect(sanitizeProperties({
      name: 'Acme',
      nested: { a: 1 },
      list: ['a', 'b'],
    })).toEqual({ name: 'Acme' });
  });

  it('keeps Date values, which serialize to an ISO string HubSpot accepts', () => {
    const when = new Date(0);
    expect(sanitizeProperties({ closedate: when })).toEqual({ closedate: when });
  });

  it('does not mutate the input and tolerates missing input', () => {
    const input = { name: 'Acme', bad: null };
    sanitizeProperties(input, new Set(['name']));
    expect(input).toEqual({ name: 'Acme', bad: null });
    expect(sanitizeProperties(null)).toEqual({});
  });
});
