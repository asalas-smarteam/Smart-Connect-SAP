import { checkOwnerMappingPatch, diffOwnerMapping } from '../../../src/domain/panel/ownerMappingEdit.js';

const VERSION = '2026-07-03T02:03:51.125Z';

function body(overrides = {}) {
  return { erpOwnerId: '113,758', erpEmployeeId: '70', expectedUpdatedAt: VERSION, ...overrides };
}

describe('checkOwnerMappingPatch (plan 12, O2)', () => {
  it('accepts both codes and returns the database fields and the version as a Date', () => {
    const result = checkOwnerMappingPatch(body());

    expect(result).toEqual({ ok: true, set: { sapOwnerId: '113,758', sapOwnerId_2: '70' }, expectedUpdatedAt: new Date(VERSION) });
  });

  it('removes every space before validating', () => {
    expect(checkOwnerMappingPatch(body({ erpOwnerId: ' 113 , 758 ,\t864 ', erpEmployeeId: ' 7 0 ' })).set)
      .toEqual({ sapOwnerId: '113,758,864', sapOwnerId_2: '70' });
  });

  it('turns null, "" and blank text into null', () => {
    expect(checkOwnerMappingPatch(body({ erpOwnerId: null, erpEmployeeId: '' })).set).toEqual({ sapOwnerId: null, sapOwnerId_2: null });
    expect(checkOwnerMappingPatch(body({ erpOwnerId: '   ' })).set.sapOwnerId).toBeNull();
  });

  it('accepts a non-negative integer and stores it as text', () => {
    expect(checkOwnerMappingPatch(body({ erpOwnerId: 53, erpEmployeeId: 0 })).set).toEqual({ sapOwnerId: '53', sapOwnerId_2: '0' });
  });

  it('accepts a single code field', () => {
    expect(checkOwnerMappingPatch({ erpEmployeeId: '9', expectedUpdatedAt: VERSION }).set).toEqual({ sapOwnerId_2: '9' });
  });

  it('allows a comma list for the seller and rejects it for the employee', () => {
    expect(checkOwnerMappingPatch(body({ erpOwnerId: '1,2,3' })).ok).toBe(true);
    const employee = checkOwnerMappingPatch(body({ erpEmployeeId: '23,24' }));
    expect(employee.ok).toBe(false);
    expect(employee.message).toMatch(/empleado/);
  });

  it.each([
    ['1,,2'], [',1'], ['1,'], ['abc'], ['1;2'], ['-1'], ['1.5'], [`${'1,'.repeat(50)}1`],
  ])('rejects the seller code %p', (erpOwnerId) => {
    const result = checkOwnerMappingPatch(body({ erpOwnerId }));
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/vendedor/);
  });

  it('rejects an employee code longer than 18 digits', () => {
    expect(checkOwnerMappingPatch(body({ erpEmployeeId: '1'.repeat(19) })).ok).toBe(false);
    expect(checkOwnerMappingPatch(body({ erpEmployeeId: '1'.repeat(18) })).ok).toBe(true);
  });

  it.each([
    [{ a: 1 }], [['1']], [true], [false], [1.5], [-3], [Number.NaN], [Number.POSITIVE_INFINITY],
  ])('rejects the value %p without throwing', (value) => {
    expect(checkOwnerMappingPatch(body({ erpOwnerId: value })).ok).toBe(false);
    expect(checkOwnerMappingPatch(body({ erpEmployeeId: value })).ok).toBe(false);
  });

  it.each(['active', 'erpOwnerName', 'crmOwnerId', 'source', 'sapOwnerId', 'hubspotCredentialId'])(
    'rejects the non-editable field %s by name',
    (field) => {
      const result = checkOwnerMappingPatch(body({ [field]: 'x' }));
      expect(result.ok).toBe(false);
      expect(result.message).toContain(field);
    }
  );

  it('asks for at least one code', () => {
    const result = checkOwnerMappingPatch({ expectedUpdatedAt: VERSION });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/vendedor o el código de empleado/);
  });

  it.each([[undefined], [null], [''], ['ayer'], ['2026-13-40T00:00:00Z'], [1700000000000], [{}]])(
    'requires a valid ISO expectedUpdatedAt (%p)',
    (expectedUpdatedAt) => {
      const input = body({ expectedUpdatedAt });
      if (expectedUpdatedAt === undefined) {
        delete input.expectedUpdatedAt;
      }
      const result = checkOwnerMappingPatch(input);
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/expectedUpdatedAt/);
    }
  );

  it.each([[null], [undefined], ['texto'], [[]], [42]])('rejects a body that is not an object (%p)', (input) => {
    expect(checkOwnerMappingPatch(input)).toEqual({ ok: false, message: 'El cuerpo debe ser un objeto JSON.' });
  });
});

describe('diffOwnerMapping (plan 12, O4)', () => {
  const current = { sapOwnerId: '53', sapOwnerId_2: '67' };

  it('lists only what really changes, with generic names', () => {
    expect(diffOwnerMapping(current, { sapOwnerId: '113,758', sapOwnerId_2: '67' }))
      .toEqual([{ field: 'erpOwnerId', from: '53', to: '113,758' }]);
  });

  it('uses null when there was nothing or the value is removed', () => {
    expect(diffOwnerMapping({ sapOwnerId: '53' }, { sapOwnerId: null, sapOwnerId_2: '70' })).toEqual([
      { field: 'erpOwnerId', from: '53', to: null },
      { field: 'erpEmployeeId', from: null, to: '70' },
    ]);
  });

  it('compares old numeric values as text and treats null and absent as the same', () => {
    expect(diffOwnerMapping({ sapOwnerId: 7 }, { sapOwnerId: '7', sapOwnerId_2: null })).toEqual([]);
  });

  it('ignores fields that are not in the set', () => {
    expect(diffOwnerMapping(current, { sapOwnerId_2: '68' })).toEqual([{ field: 'erpEmployeeId', from: '67', to: '68' }]);
  });
});
