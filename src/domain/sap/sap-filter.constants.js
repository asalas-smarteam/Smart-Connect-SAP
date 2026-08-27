// Operators accepted by the SAP filter builders.
//
// 'eq', 'ge', 'startswith' and 'not_startswith' are the historical B1 set.
// 'ne' works in both builders (S/4 "Customer ne ''" and B1
// "GlobalLocationNumber ne 'PERSONA/NEGOCIO'"); ojo que 'ne' descarta los
// registros con la columna en null, así que para campos opcionales va
// 'ne_or_null', que renderiza "(col eq null or col ne 'X')" en ambos builders.
// 'in' stays S/4-only: OData v2 has no `in`, so the S/4 builder renders it as
// an OR group while the B1 builder rejects it, surfacing a misconfigured B1
// tenant instead of silently ignoring the filter.
export const SAP_FILTER_OPERATORS = Object.freeze([
  'eq',
  'ne',
  'ne_or_null',
  'ge',
  'in',
  'startswith',
  'not_startswith',
]);

export const SAP_FILTER_DYNAMIC_TYPES = Object.freeze(['datetime', 'date', 'time']);

export default { SAP_FILTER_OPERATORS, SAP_FILTER_DYNAMIC_TYPES };
