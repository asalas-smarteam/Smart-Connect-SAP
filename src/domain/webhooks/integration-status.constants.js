// Los tres estados terminales que el integrador publica en el deal de HubSpot. Son llaves
// internas: el valor concreto que se escribe en la propiedad lo define cada tenant en su
// configuración, porque un tenant puede querer reusar una propiedad de estado que ya tenía.
//
// `Reintentar` no está acá a propósito: ese valor solo lo escribe el asesor a mano y solo lo
// lee el workflow de HubSpot. El integrador nunca lo escribe.
export const INTEGRATION_STATUS_KEYS = Object.freeze({
  // El evento quedó `completed`.
  COMPLETED: 'completed',
  // El evento quedó `errored`: no hay documento en SAP y el reenvío está habilitado.
  ERROR_RETRY: 'errorRetry',
  // El evento quedó `sap_created_hubspot_error`: SAP ya tiene el documento, así que reenviar
  // lo duplicaría. Requiere intervención de soporte.
  ERROR_SUPPORT: 'errorSupport',
});

export const INTEGRATION_STATUS_KEY_LIST = Object.freeze(
  Object.values(INTEGRATION_STATUS_KEYS)
);

export default { INTEGRATION_STATUS_KEYS, INTEGRATION_STATUS_KEY_LIST };
