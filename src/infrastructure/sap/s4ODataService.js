import { SAP_FLAVORS } from '#domain/sap/sap-flavor.constants.js';
import logger from '../logger/logger.js';
import { createSapTransport } from './transport/sapTransportFactory.js';
import { buildS4ODataQuery } from './s4ODataQueryBuilder.js';

// Fetch path for tenants running SAP S/4HANA (S4_ODATA integration mode).
// Mirrors serviceLayer.service.js: takes the merged SapCredentials +
// ClientConfig and the active FieldMappings, and returns raw (transport
// normalized) records for the existing mapping pipeline to consume.
const s4ODataService = {
  async execute(config, mappings, options = {}, { transport = null } = {}) {
    const resolvedTransport = transport || createSapTransport({
      sapFlavor: SAP_FLAVORS.S4,
      config,
    });

    const { path, query } = buildS4ODataQuery(config, mappings, options);

    logger.info('Fetching SAP S/4 data', {
      path,
      select: query.$select,
      expand: query.$expand ?? null,
      hasFilter: Boolean(query.$filter),
    });

    return resolvedTransport.fetchAll({ path, query });
  },
};

export default s4ODataService;
