import { createPort } from '../port-validator.js';

// Transport-level abstraction over the SAP HTTP dialects.
// Implementations own: auth (session cookie vs basic), base path
// (/b1s/v2 vs /sap/opu/odata/sap), response envelope, pagination
// and date normalization. Callers speak entity paths + OData query
// options and receive plain JSON with ISO-8601 dates.
export const SapTransportPort = createPort({
  name: 'SapTransportPort',
  methods: [
    // request({ method, path, query, headers, body }) -> normalized payload
    'request',
    // fetchAll({ path, query, headers }) -> array (follows pagination)
    'fetchAll',
  ],
});

export default SapTransportPort;
