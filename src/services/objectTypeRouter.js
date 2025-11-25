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

  return null;
}

export default {
  getObjectTypeHandler,
};
