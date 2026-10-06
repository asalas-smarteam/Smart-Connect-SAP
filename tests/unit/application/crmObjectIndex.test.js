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
    // A record that already belongs to C777 is never adopted through the
    // fallback by a row with another idsap (or with none).
    expect(index.find({ idsap: 'nope', email: 'new@x.com' })).toBeNull();
    index.add({ id: 'hs-lead', properties: { email: 'lead@x.com' } });
    expect(index.find({ idsap: 'nope', email: 'lead@x.com' })?.id).toBe('hs-lead');
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
      records: [contact('hs-1', { idsap: '', email: 'a@x.com' })],
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
      records: [contact('hs-1', { cedula: 'NOPE', email: 'a@x.com' })],
      identityProperty: 'idsap',
      fallbackProperty: 'cedula',
      uniqueProperties: ['email'],
    });

    // The row carries a cedula that matches nothing; before, that returned null
    // outright and the record was created into a 409.
    expect(index.find({ idsap: 'C001', cedula: 'MISS', email: 'a@x.com' })).toMatchObject({ id: 'hs-1' });
  });

  it('never returns, even on a unique property, a record owned by another idsap', () => {
    const index = new CrmObjectIndex({
      records: [contact('hs-1', { idsap: 'OTHER', email: 'a@x.com' })],
      identityProperty: 'idsap',
      uniqueProperties: ['email'],
    });

    // Updating it would overwrite OTHER's idsap and name. The create this leads
    // to is answered with 409 and linked by the conflict path, writing nothing.
    expect(index.find({ idsap: 'C001', email: 'a@x.com' })).toBeNull();
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

// Regla de noelito (defaultFindHubspot = phone): primero idsap; si lo encuentra
// no se busca por nada más. Si no existe por idsap, cae al teléfono, pero solo
// a registros que no pertenecen a otro objeto de SAP.
describe('CrmObjectIndex idsap -> phone rule', () => {
  const contact = (id, properties) => ({ id, properties });
  const buildPhoneIndex = (records) => new CrmObjectIndex({
    records,
    identityProperty: 'idsap',
    fallbackProperty: 'phone',
    uniqueProperties: ['email'],
    ownershipProperties: ['idsap', 'internalcode'],
  });

  it('uses the idsap match and ignores a phone that points to another record', () => {
    const index = buildPhoneIndex([
      contact('hs-lead', { phone: '+50527741100' }),
      contact('hs-bp', { idsap: 'CL00015', phone: '' }),
    ]);

    expect(index.match({ idsap: 'CL00015', phone: '+50527741100' })).toEqual({
      record: expect.objectContaining({ id: 'hs-bp' }),
      via: 'identity',
    });
  });

  it('adopts a lead without SAP keys by phone when the idsap does not exist', () => {
    const index = buildPhoneIndex([contact('hs-lead', { phone: '+50527741100' })]);

    expect(index.match({ idsap: 'CL00015', phone: '+50527741100' })).toEqual({
      record: expect.objectContaining({ id: 'hs-lead' }),
      via: 'fallback',
    });
  });

  it('does not adopt by phone a record that already has another idsap', () => {
    const index = buildPhoneIndex([contact('hs-other', { idsap: 'CL00501', phone: '+50588888888' })]);

    expect(index.find({ idsap: 'CL00578', phone: '+50588888888' })).toBeNull();
  });

  it('does not adopt by phone a ContactEmployee record (internalcode)', () => {
    const index = buildPhoneIndex([contact('hs-ce', { internalcode: '123', phone: '+50588888888' })]);

    expect(index.find({ idsap: 'CL00578', phone: '+50588888888' })).toBeNull();
  });

  it('skips an owned record and still finds a free lead with the same phone', () => {
    const index = buildPhoneIndex([
      contact('hs-other', { idsap: 'CL00501', phone: '+50588888888' }),
      contact('hs-lead', { phone: '+50588888888' }),
    ]);

    expect(index.find({ idsap: 'CL00578', phone: '+50588888888' })?.id).toBe('hs-lead');
  });
});
