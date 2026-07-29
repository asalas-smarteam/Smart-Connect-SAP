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
