// Compuerta de la sincronización de direcciones SAP -> HubSpot. Hoy siempre
// apagada: un BusinessPartner de SAP tiene N direcciones y una company de
// HubSpot un solo juego de propiedades de dirección, así que el destino correcto
// es un custom object de HubSpot y eso es un spec aparte. La clave existe para
// declarar la intención y para que un tenant no active algo que no está hecho
// sin enterarse.
//
// Viven en el dominio, no en el repositorio, porque los consumen las dos capas:
// el repositorio de infraestructura lee la clave, y el use-case de aplicación
// usa el código en su warning. Con las constantes acá, ninguna capa de
// aplicación necesita importar de `#infrastructure/*` sólo para nombrar un
// string, que sería la única inversión de dependencia del repositorio.
export const REQUIRE_ADDRESS_CONFIG_KEY = 'requireAddress';
export const ADDRESS_SYNC_NOT_IMPLEMENTED = 'ADDRESS_SYNC_NOT_IMPLEMENTED';
