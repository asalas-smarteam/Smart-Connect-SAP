import { toNonEmptyString } from './string.utils.js';

export function extractAssociationIds(record, associationName) {
  const results = Array.isArray(record?.associations?.[associationName]?.results)
    ? record.associations[associationName].results
    : [];

  return results
    .map((item) => toNonEmptyString(item?.id))
    .filter(Boolean);
}

// HubSpot expone la asociación de line items con varios alias según el endpoint.
export function extractLineItemAssociationIds(record) {
  return [
    ...extractAssociationIds(record, 'line_items'),
    ...extractAssociationIds(record, 'lineItems'),
    ...extractAssociationIds(record, 'line items'),
    ...extractAssociationIds(record, 'products'),
  ].filter((value, index, items) => items.indexOf(value) === index);
}
