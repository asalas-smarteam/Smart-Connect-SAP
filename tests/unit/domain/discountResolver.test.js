import { resolveDiscount } from '../../../src/domain/products/discount-resolver.service.js';

const CURRENT_DATE = new Date('2026-06-30T12:00:00Z');

function buildDiscountGroup({
  validFrom = '2026-06-30T00:00:00Z',
  validTo = '2026-07-04T00:00:00Z',
  lines = [],
} = {}) {
  return {
    AbsEntry: 1,
    ValidFrom: validFrom,
    ValidTo: validTo,
    DiscountGroupLineCollection: lines,
  };
}

describe('resolveDiscount', () => {
  it('returns null when there are no discount groups', () => {
    expect(resolveDiscount([], { itemCode: 'A01', itemsGroupCode: '141', currentDate: CURRENT_DATE })).toBeNull();
  });

  it('returns the item-level discount when ItemCode matches ObjectCode', () => {
    const discountGroups = [
      buildDiscountGroup({
        lines: [
          { ObjectType: 'dgboItems', ObjectCode: 'A01050094', Discount: 10 },
          { ObjectType: 'dgboItemGroups', ObjectCode: '141', Discount: 5 },
        ],
      }),
    ];

    const discount = resolveDiscount(discountGroups, {
      itemCode: 'A01050094',
      itemsGroupCode: '141',
      currentDate: CURRENT_DATE,
    });

    expect(discount).toBe(10);
  });

  it('falls back to the group-level discount when no item-level match exists', () => {
    const discountGroups = [
      buildDiscountGroup({
        lines: [
          { ObjectType: 'dgboItemGroups', ObjectCode: '141', Discount: 5 },
        ],
      }),
    ];

    const discount = resolveDiscount(discountGroups, {
      itemCode: 'A01050094',
      itemsGroupCode: '141',
      currentDate: CURRENT_DATE,
    });

    expect(discount).toBe(5);
  });

  it('prioritizes the item-level discount over the group-level discount', () => {
    const discountGroups = [
      buildDiscountGroup({
        lines: [
          { ObjectType: 'dgboItemGroups', ObjectCode: '141', Discount: 5 },
          { ObjectType: 'dgboItems', ObjectCode: 'A01050094', Discount: 10 },
        ],
      }),
    ];

    const discount = resolveDiscount(discountGroups, {
      itemCode: 'A01050094',
      itemsGroupCode: '141',
      currentDate: CURRENT_DATE,
    });

    expect(discount).toBe(10);
  });

  it('returns null when the current date is before ValidFrom', () => {
    const discountGroups = [
      buildDiscountGroup({
        validFrom: '2026-07-10T00:00:00Z',
        validTo: '2026-07-15T00:00:00Z',
        lines: [{ ObjectType: 'dgboItems', ObjectCode: 'A01050094', Discount: 10 }],
      }),
    ];

    const discount = resolveDiscount(discountGroups, {
      itemCode: 'A01050094',
      itemsGroupCode: '141',
      currentDate: CURRENT_DATE,
    });

    expect(discount).toBeNull();
  });

  it('returns null when the current date is after ValidTo', () => {
    const discountGroups = [
      buildDiscountGroup({
        validFrom: '2026-06-01T00:00:00Z',
        validTo: '2026-06-15T00:00:00Z',
        lines: [{ ObjectType: 'dgboItems', ObjectCode: 'A01050094', Discount: 10 }],
      }),
    ];

    const discount = resolveDiscount(discountGroups, {
      itemCode: 'A01050094',
      itemsGroupCode: '141',
      currentDate: CURRENT_DATE,
    });

    expect(discount).toBeNull();
  });

  it('matches an open-ended discount group with no ValidTo (permanent discount)', () => {
    const discountGroups = [
      buildDiscountGroup({
        validFrom: '2026-06-01T00:00:00Z',
        validTo: null,
        lines: [{ ObjectType: 'dgboItems', ObjectCode: 'A01050094', Discount: 10 }],
      }),
    ];

    const discount = resolveDiscount(discountGroups, {
      itemCode: 'A01050094',
      itemsGroupCode: '141',
      currentDate: CURRENT_DATE,
    });

    expect(discount).toBe(10);
  });

  it('matches a discount group with no ValidFrom (valid since always)', () => {
    const discountGroups = [
      buildDiscountGroup({
        validFrom: null,
        validTo: '2026-07-04T00:00:00Z',
        lines: [{ ObjectType: 'dgboItems', ObjectCode: 'A01050094', Discount: 10 }],
      }),
    ];

    const discount = resolveDiscount(discountGroups, {
      itemCode: 'A01050094',
      itemsGroupCode: '141',
      currentDate: CURRENT_DATE,
    });

    expect(discount).toBe(10);
  });

  it('matches a discount group with both ValidFrom and ValidTo absent', () => {
    const discountGroups = [
      buildDiscountGroup({
        validFrom: null,
        validTo: null,
        lines: [{ ObjectType: 'dgboItems', ObjectCode: 'A01050094', Discount: 10 }],
      }),
    ];

    const discount = resolveDiscount(discountGroups, {
      itemCode: 'A01050094',
      itemsGroupCode: '141',
      currentDate: CURRENT_DATE,
    });

    expect(discount).toBe(10);
  });

  it('returns null when ValidFrom or ValidTo is an unparseable date', () => {
    const discountGroups = [
      buildDiscountGroup({
        validFrom: 'not-a-date',
        validTo: '2026-07-04T00:00:00Z',
        lines: [{ ObjectType: 'dgboItems', ObjectCode: 'A01050094', Discount: 10 }],
      }),
    ];

    const discount = resolveDiscount(discountGroups, {
      itemCode: 'A01050094',
      itemsGroupCode: '141',
      currentDate: CURRENT_DATE,
    });

    expect(discount).toBeNull();
  });

  it('returns null when neither ItemCode nor ItemsGroupCode matches', () => {
    const discountGroups = [
      buildDiscountGroup({
        lines: [
          { ObjectType: 'dgboItems', ObjectCode: 'B999', Discount: 10 },
          { ObjectType: 'dgboItemGroups', ObjectCode: '999', Discount: 5 },
        ],
      }),
    ];

    const discount = resolveDiscount(discountGroups, {
      itemCode: 'A01050094',
      itemsGroupCode: '141',
      currentDate: CURRENT_DATE,
    });

    expect(discount).toBeNull();
  });
});
