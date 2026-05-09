import { createCompany, findCompanyByEmail, updateCompany } from './hubspotClient.js';

export const hubspotCompanyAdapter = Object.freeze({
  createCompany,
  findCompanyByEmail,
  updateCompany,
});

export default hubspotCompanyAdapter;

