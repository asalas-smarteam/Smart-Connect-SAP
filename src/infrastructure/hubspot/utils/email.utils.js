import { slugCompanyName } from './string.utils.js';

export function generateFallbackEmail(baseEmail, companyName) {
  const normalizedEmail = String(baseEmail || '').trim().toLowerCase();

  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    return null;
  }

  const [localPart, domain] = normalizedEmail.split('@');

  if (!localPart || !domain) {
    return null;
  }

  const companySlug = slugCompanyName(companyName) || 'company';

  return `${localPart}+${companySlug}@${domain}`;
}

export default {
  generateFallbackEmail,
};
