// Operators accepted by the SAP filter builders.
//
// 'eq', 'ge', 'startswith' and 'not_startswith' are the historical B1 set.
// 'ne' works in both builders (S/4 "Customer ne ''" and B1
// "GlobalLocationNumber ne 'PERSONA/NEGOCIO'"); ojo que 'ne' descarta los
// registros con la columna en null, así que para campos opcionales va
// 'ne_or_null', que renderiza "(col eq null or col ne 'X')" en ambos builders.
// 'in' lleva un arreglo de valores y funciona en ambos builders: OData v2 no tiene
// `in`, asi que los dos lo renderizan como un grupo OR entre parentesis. El B1
// preserva el tipo de cada miembro (los codigos numericos como ItemsGroupCode van
// sin comillas, porque B1 rechaza comparar un Edm.Int32 contra un literal string);
// el de S/4 los emite siempre como string, que es lo que necesitan los groupings
// tipo ZC01.
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
