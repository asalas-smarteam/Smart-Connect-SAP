// A reverse proxy in front of the B1 Service Layer can require a bearer token
// before the request reaches SAP. The token lives in the tenant's SapCredentials
// and is sent on every Service Layer request, Login included. It is never
// forwarded to SAP, never logged and never recorded with the call.
export function buildGatewayAuthHeaders(config) {
  const raw = config?.serviceLayerGatewayToken;
  const token = typeof raw === 'string' ? raw.trim() : '';

  return token ? { Authorization: `Bearer ${token}` } : {};
}

export default buildGatewayAuthHeaders;
