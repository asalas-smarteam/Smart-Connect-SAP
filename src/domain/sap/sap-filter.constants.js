// Operators accepted by the SAP filter builders.
//
// 'eq', 'ge', 'startswith' and 'not_startswith' are the historical B1 set.
// 'ne' and 'in' were added for S/4 (Customer ne '' and
// BusinessPartnerGrouping in [ZC01, ZC02]); OData v2 has no `in`, so the
// S/4 builder renders it as an OR group. The B1 builder rejects both, which
// surfaces a misconfigured B1 tenant instead of silently ignoring a filter.
export const SAP_FILTER_OPERATORS = Object.freeze([
  'eq',
  'ne',
  'ge',
  'in',
  'startswith',
  'not_startswith',
]);

export const SAP_FILTER_DYNAMIC_TYPES = Object.freeze(['datetime', 'date', 'time']);

export default { SAP_FILTER_OPERATORS, SAP_FILTER_DYNAMIC_TYPES };
