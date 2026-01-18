const COMPANY_NAME_MIN_LENGTH = 3;
const COMPANY_NAME_MAX_LENGTH = 80;
const COLLECTION_NAME_MIN_LENGTH = 3;
const COLLECTION_NAME_MAX_LENGTH = 63;

function sanitizeMongoCollectionName(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function validateProvisioningPayload(payload) {
  const nombreEmpresa = payload?.nombreEmpresa;

  if (!nombreEmpresa || typeof nombreEmpresa !== 'string' || !nombreEmpresa.trim()) {
    return {
      valid: false,
      error: 'nombreEmpresa is required',
    };
  }

  const normalizedCompanyName = nombreEmpresa.trim();
  const normalizedLength = normalizedCompanyName.length;

  if (
    normalizedLength < COMPANY_NAME_MIN_LENGTH ||
    normalizedLength > COMPANY_NAME_MAX_LENGTH
  ) {
    return {
      valid: false,
      error: `nombreEmpresa must be between ${COMPANY_NAME_MIN_LENGTH} and ${COMPANY_NAME_MAX_LENGTH} characters`,
    };
  }

  const sanitizedCollectionName = sanitizeMongoCollectionName(normalizedCompanyName);
  const sanitizedLength = sanitizedCollectionName.length;

  if (
    !sanitizedCollectionName ||
    sanitizedLength < COLLECTION_NAME_MIN_LENGTH ||
    sanitizedLength > COLLECTION_NAME_MAX_LENGTH
  ) {
    return {
      valid: false,
      error: 'nombreEmpresa must yield a valid MongoDB collection name',
    };
  }

  return {
    valid: true,
    normalizedCompanyName,
    sanitizedCollectionName,
  };
}

export {
  COMPANY_NAME_MIN_LENGTH,
  COMPANY_NAME_MAX_LENGTH,
  COLLECTION_NAME_MIN_LENGTH,
  COLLECTION_NAME_MAX_LENGTH,
  sanitizeMongoCollectionName,
  validateProvisioningPayload,
};
