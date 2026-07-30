// HubSpot rejects any record that ends up carrying both the absolute discount
// and the percentage one:
//
//   "Cannot set both discount {{ discount }} and discountPercentage {{ discountPercentage }}"
//
// The check runs against the *resulting* record, so a value left over from a
// previous sync is enough to trigger it even when the current payload only
// writes one of the two. Writing either property must therefore blank the other
// one in the same payload.
export const DISCOUNT_PROPERTY_COUNTERPARTS = Object.freeze({
  discount: 'hs_discount_percentage',
  hs_discount_percentage: 'discount',
});

// Any other property configured in `requireDiscounts.fieldMappings.Discount` is
// a tenant custom field; the native property that can still conflict with it is
// `discount`.
const FALLBACK_COUNTERPART = 'discount';

/**
 * Builds the discount slice of a HubSpot payload: the configured property with
 * its value, plus the mutually exclusive one cleared to an empty string.
 *
 * Returns an empty object when no discount property is configured, so callers
 * can spread it unconditionally.
 */
export function buildExclusiveDiscountProperties(discountProperty, value) {
  const property = String(discountProperty ?? '').trim();

  if (!property) {
    return {};
  }

  const properties = { [property]: value };
  const counterpart = DISCOUNT_PROPERTY_COUNTERPARTS[property] ?? FALLBACK_COUNTERPART;

  if (counterpart !== property) {
    properties[counterpart] = '';
  }

  return properties;
}

export default buildExclusiveDiscountProperties;
