import { describe, expect, it } from '@jest/globals';
import { buildExclusiveDiscountProperties } from '#domain/products/discount-properties.service.js';

describe('buildExclusiveDiscountProperties', () => {
  it('blanks discount when the tenant syncs the percentage property', () => {
    expect(buildExclusiveDiscountProperties('hs_discount_percentage', 10)).toEqual({
      hs_discount_percentage: 10,
      discount: '',
    });
  });

  it('blanks the percentage when the tenant syncs the absolute discount', () => {
    expect(buildExclusiveDiscountProperties('discount', 10)).toEqual({
      discount: 10,
      hs_discount_percentage: '',
    });
  });

  it('never blanks the property it is writing', () => {
    const properties = buildExclusiveDiscountProperties('discount', 0);

    expect(properties.discount).toBe(0);
    expect(Object.keys(properties)).toHaveLength(2);
  });

  it('falls back to blanking the native discount for a custom property', () => {
    expect(buildExclusiveDiscountProperties('mi_descuento', '15')).toEqual({
      mi_descuento: '15',
      discount: '',
    });
  });

  it('returns nothing when no discount property is configured', () => {
    expect(buildExclusiveDiscountProperties(null, 10)).toEqual({});
    expect(buildExclusiveDiscountProperties('   ', 10)).toEqual({});
  });
});
