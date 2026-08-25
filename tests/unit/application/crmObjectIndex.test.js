import { CrmObjectIndex, normalizeIndexKey } from '../../../src/application/services/crmObjectIndex.service.js';

const records = [
  { id: 'hs-1', properties: { idsap: 'C001', email: 'a@x.com' } },
  { id: 'hs-2', properties: { idsap: ' C002 ', email: 'B@X.com' } },
  { id: 'hs-3', properties: { idsap: '', email: 'c@x.com' } },
  { id: 'hs-4', properties: { idsap: 'C001', email: 'dupe@x.com' } },
];

function buildIndex(overrides = {}) {
  return new CrmObjectIndex({ records, identityProperty: 'idsap', fallbackProperty: 'email', ...overrides });
}

describe('normalizeIndexKey', () => {
  it('trims and lowercases, and maps empty values to an empty string', () => {
    expect(normalizeIndexKey(' C001 ')).toBe('c001');
    expect(normalizeIndexKey('B@X.com')).toBe('b@x.com');
    expect(normalizeIndexKey(null)).toBe('');
    expect(normalizeIndexKey(undefined)).toBe('');
    expect(normalizeIndexKey(0)).toBe('0');
  });
});

describe('CrmObjectIndex', () => {
  it('matches by identity property regardless of case and padding', () => {
    const index = buildIndex();
    expect(index.find({ idsap: 'c001' })?.id).toBe('hs-1');
    expect(index.find({ idsap: 'C002' })?.id).toBe('hs-2');
  });

  it('keeps the first record when two share an identity value', () => {
    expect(buildIndex().find({ idsap: 'C001' })?.id).toBe('hs-1');
  });

  it('falls back to the secondary property only when identity does not match', () => {
    const index = buildIndex();
    // identity misses, fallback hits
    expect(index.find({ idsap: 'C999', email: 'c@x.com' })?.id).toBe('hs-3');
    // identity hits: fallback is not consulted even though it points elsewhere
    expect(index.find({ idsap: 'C001', email: 'c@x.com' })?.id).toBe('hs-1');
  });

  it('returns null when neither property matches', () => {
    expect(buildIndex().find({ idsap: 'C999', email: 'nope@x.com' })).toBeNull();
    expect(buildIndex().find({})).toBeNull();
  });

  it('ignores the fallback when it is the same property as identity', () => {
    const index = new CrmObjectIndex({ records, identityProperty: 'idsap', fallbackProperty: 'idsap' });
    expect(index.find({ idsap: 'C001' })?.id).toBe('hs-1');
    expect(index.find({ idsap: 'C999' })).toBeNull();
  });

  it('indexes records added after construction', () => {
    const index = buildIndex();
    expect(index.find({ idsap: 'C777' })).toBeNull();
    index.add({ id: 'hs-new', properties: { idsap: 'C777', email: 'new@x.com' } });
    expect(index.find({ idsap: 'C777' })?.id).toBe('hs-new');
    expect(index.find({ idsap: 'nope', email: 'new@x.com' })?.id).toBe('hs-new');
  });

  it('reports how many identity keys it holds', () => {
    expect(buildIndex().size).toBe(2);
  });
});

// HubSpot enforces email uniqueness on contacts no matter what the tenant
// configured as its identity property. When the index cannot match on email, a
// contact whose email already exists is classified as "create", HubSpot answers
// 409, and the old code degraded that chunk to one Search call per record --
// which is what saturated the 5/s search limit and produced the 429 storm.
describe('CrmObjectIndex unique-property tier', () => {
  const contact = (id, properties) => ({ id, properties });

  it('matches a record on a unique property when identity and fallback both miss', () => {
    const index = new CrmObjectIndex({
      records: [contact('hs-1', { idsap: 'OTHER', email: 'a@x.com' })],
      identityProperty: 'idsap',
      fallbackProperty: 'idsap',
      uniqueProperties: ['email'],
    });

    expect(index.find({ idsap: 'C001', email: 'a@x.com' })).toMatchObject({ id: 'hs-1' });
  });

  it('still prefers the identity match over the unique property', () => {
    const index = new CrmObjectIndex({
      records: [
        contact('hs-identity', { idsap: 'C001', email: 'shared@x.com' }),
        contact('hs-email', { idsap: 'C002', email: 'shared@x.com' }),
      ],
      identityProperty: 'idsap',
      uniqueProperties: ['email'],
    });

    expect(index.find({ idsap: 'C002', email: 'shared@x.com' })).toMatchObject({ id: 'hs-email' });
    expect(index.find({ idsap: 'C001', email: 'shared@x.com' })).toMatchObject({ id: 'hs-identity' });
  });

  it('falls through to the unique property when the fallback tier misses', () => {
    const index = new CrmObjectIndex({
      records: [contact('hs-1', { idsap: 'OTHER', cedula: 'NOPE', email: 'a@x.com' })],
      identityProperty: 'idsap',
      fallbackProperty: 'cedula',
      uniqueProperties: ['email'],
    });

    // The row carries a cedula that matches nothing; before, that returned null
    // outright and the record was created into a 409.
    expect(index.find({ idsap: 'C001', cedula: 'MISS', email: 'a@x.com' })).toMatchObject({ id: 'hs-1' });
  });

  it('does not match on a unique property that was not declared', () => {
    const index = new CrmObjectIndex({
      records: [contact('hs-1', { idsap: 'OTHER', email: 'a@x.com' })],
      identityProperty: 'idsap',
    });

    // Companies have no HubSpot-enforced email uniqueness, so nothing is implied.
    expect(index.find({ idsap: 'C001', email: 'a@x.com' })).toBeNull();
  });
});

describe('emailOwner', () => {
  it('devuelve el dueño actual de un email del tier único', () => {
    const index = new CrmObjectIndex({
      records: [{ id: 'hs-1', properties: { internalcode: 'IC-1', email: 'Shared@X.com' } }],
      identityProperty: 'internalcode',
      uniqueProperties: ['email'],
    });

    expect(index.emailOwner(' shared@x.COM ')?.id).toBe('hs-1');
    expect(index.emailOwner('libre@x.com')).toBeNull();
    expect(index.emailOwner('')).toBeNull();
  });

  it('devuelve null cuando el índice no declara email como único (companies)', () => {
    const index = new CrmObjectIndex({
      records: [{ id: 'hs-1', properties: { idsap: 'C1', email: 'a@b.com' } }],
      identityProperty: 'idsap',
      uniqueProperties: [],
    });

    expect(index.emailOwner('a@b.com')).toBeNull();
  });
});
