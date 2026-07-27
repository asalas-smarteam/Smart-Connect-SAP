import {
  DEFAULT_SAP_FLAVOR,
  SAP_FLAVORS,
  normalizeSapFlavor,
} from '#domain/sap/sap-flavor.constants.js';
import { assertPort } from '#application/ports/port-validator.js';
import { SapTransportPort } from '#application/ports/sap/sap-transport.port.js';
import { B1ServiceLayerTransport } from './B1ServiceLayerTransport.js';
import { S4GatewayTransport } from './S4GatewayTransport.js';

// Resolves the transport implementation for a tenant SAP flavor.
// Unknown/absent flavors fall back to B1 to preserve current behavior.
export function createSapTransport({ sapFlavor, config } = {}) {
  const flavor = normalizeSapFlavor(sapFlavor) || DEFAULT_SAP_FLAVOR;

  const transport = flavor === SAP_FLAVORS.S4
    ? new S4GatewayTransport({ config })
    : new B1ServiceLayerTransport({ config });

  return assertPort(transport, SapTransportPort);
}

export default createSapTransport;
