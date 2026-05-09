export function slugCompanyName(companyName) {
  return String(companyName || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export default {
  slugCompanyName,
};
