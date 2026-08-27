// HubSpot valida las propiedades de teléfono cuando el portal tiene activada la
// validación de número: exige E.164 ('+' + código de país + dígitos, hasta 15),
// opcionalmente con extensión. Cualquier otra cosa hace que la API responda 400
// con INVALID_PHONE_NUMBER y el registro COMPLETO se queda sin sincronizar, no
// solo el teléfono.
//
// SAP B1 no guarda el teléfono en E.164: OCRD.Phone1 es texto libre y el usuario
// escribe '3192 3094', '2222-3333', '8888 9999 / 2222 1111' o lo que sea.
//
// La conversión es por TARGET field, no por source, porque la validación que
// falla es la de la propiedad de HubSpot: da igual de qué campo de SAP venga el
// dato, si aterriza en `phone` tiene que ser E.164. Es la diferencia con
// SAP_BOOLEAN_SOURCE_FIELDS, que sí va por source porque ahí el problema es el
// enum de SAP.
//
// La lista arranca solo con 'phone' a propósito: es el único targetField de
// teléfono que existe hoy en los mapeos, y nulificar una propiedad que ningún
// cliente pidió tocar es pérdida de dato silenciosa. Agregar 'mobilephone' u
// otra el día que se mapee es una línea.
export const HUBSPOT_PHONE_TARGET_FIELDS = Object.freeze([
  'phone',
]);

export default {
  HUBSPOT_PHONE_TARGET_FIELDS,
};
