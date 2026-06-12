export function isBasicEmailFormat(email) {
  const value = String(email ?? '').trim();

  return /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(value);
}

export default {
  isBasicEmailFormat,
};
