// SAP Business One expresa los booleanos con el enum BoYesNoEnum, cuyos únicos
// valores son 'tYES' y 'tNO'. HubSpot no los entiende: una propiedad de tipo
// casilla espera true/false, y una de texto se queda con el literal 'tYES'.
//
// La conversión es por LISTA de campos, no por forma del valor, a propósito.
// 'tYES' aparece en muchos campos más (Valid, Frozen, Locked, WasCounted,
// IndEscala...), así que convertir por forma cambiaría lo que envían mapeos que
// ningún cliente pidió tocar: uno que hoy escribe 'tYES' en una propiedad de
// texto pasaría a escribir true, sin aviso y sin error. La regla del proyecto
// es que un mapeo del cliente no se cambia sin que lo pida.
//
// Agregar un campo acá es una línea, y aplica a los dos caminos de mapeo
// (sync programado y webhooks) porque los dos pasan por buildMappedProperties.
//
// 'Active' (ContactEmployees.Active) entró el 2026-08-25: HubSpot devolvía 400
// INVALID_OPTION ("tYES was not one of the allowed options: [true, false]") y
// ese 400 tumba el POST completo del contacto, así que se perdía el contacto
// entero -- nombre, email, teléfono -- por una casilla.
export const SAP_BOOLEAN_SOURCE_FIELDS = Object.freeze([
  'InventoryItem',
  'SalesItem',
  'Active',
]);

export const SAP_BOOLEAN_TRUE = 'tYES';
export const SAP_BOOLEAN_FALSE = 'tNO';

export default {
  SAP_BOOLEAN_SOURCE_FIELDS,
  SAP_BOOLEAN_TRUE,
  SAP_BOOLEAN_FALSE,
};
