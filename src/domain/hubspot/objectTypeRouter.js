export function getObjectTypeHandler(objectType) {
  if (objectType === 'contact') {
    return 'contacts';
  }

  if (objectType === 'company') {
    return 'companies';
  }

  if (objectType === 'deal') {
    return 'deals';
  }

  if (objectType === 'product') {
    return 'products';
  }

  return null;
}

// The CRM metadata API accepts either a known collection name or an object type
// id / fully qualified name for custom objects ('2-1234567', 'p_pedido'), so an
// unrecognized value is passed through untouched instead of failing. Callers
// that need a *supported* record pipeline must keep using
// getObjectTypeHandler and its null.
export function resolveHubspotObjectType(objectType) {
  const known = getObjectTypeHandler(objectType);

  if (known) {
    return known;
  }

  const raw = String(objectType ?? '').trim();
  return raw || null;
}

export default {
  getObjectTypeHandler,
  resolveHubspotObjectType,
};
