// SAP Business One expresa los booleanos con el enum BoYesNoEnum, cuyos únicos
// valores son 'tYES' y 'tNO'. HubSpot no los entiende: una propiedad de tipo
// casilla espera true/false, y una de texto se queda con el literal 'tYES'.
//
// La conversión es por LISTA de campos, no por forma del valor, a propósito.
// 'tYES' aparece en muchos campos más (Valid, Frozen, Locked, WasCounted,
// IndEscala, Active...), así que convertir por forma cambiaría lo que envían
// mapeos que ningún cliente pidió tocar: uno que hoy escribe 'tYES' en una
// propiedad de texto pasaría a escribir true, sin aviso y sin error. La regla
// del proyecto es que un mapeo del cliente no se cambia sin que lo pida.
//
// Agregar un campo acá es una línea, y aplica a los dos caminos de mapeo
// (sync programado y webhooks) porque los dos pasan por buildMappedProperties.
export const SAP_BOOLEAN_SOURCE_FIELDS = Object.freeze([
  'InventoryItem',
  'SalesItem',
]);

export const SAP_BOOLEAN_TRUE = 'tYES';
export const SAP_BOOLEAN_FALSE = 'tNO';

export default {
  SAP_BOOLEAN_SOURCE_FIELDS,
  SAP_BOOLEAN_TRUE,
  SAP_BOOLEAN_FALSE,
};
