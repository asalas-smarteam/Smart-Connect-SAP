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

export default {
  getObjectTypeHandler,
};
