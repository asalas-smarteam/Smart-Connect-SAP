import {
  DEFAULT_SAP_FLAVOR,
  SAP_FLAVORS,
  normalizeSapFlavor,
} from '#domain/sap/sap-flavor.constants.js';
import { assertPort } from '#application/ports/port-validator.js';
import { SapCustomerPort } from '#application/ports/sap/sap-customer.port.js';
import { createSapTransport } from '../transport/sapTransportFactory.js';
import { B1CustomerAdapter } from './B1CustomerAdapter.js';
import { S4CustomerAdapter } from './S4CustomerAdapter.js';

// Resolves the customer adapter for a tenant SAP flavor. A transport can be
// injected (tests/reuse); otherwise one is built for the same flavor.
export function createSapCustomerAdapter({ sapFlavor, config, transport } = {}) {
  const flavor = normalizeSapFlavor(sapFlavor) || DEFAULT_SAP_FLAVOR;
  const resolvedTransport = transport || createSapTransport({ sapFlavor: flavor, config });

  const adapter = flavor === SAP_FLAVORS.S4
    ? new S4CustomerAdapter({ transport: resolvedTransport })
    : new B1CustomerAdapter({ transport: resolvedTransport });

  return assertPort(adapter, SapCustomerPort);
}

export default createSapCustomerAdapter;
