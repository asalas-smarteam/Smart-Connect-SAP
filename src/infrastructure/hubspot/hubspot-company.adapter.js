import { createCompany, findCompanyByEmail, updateCompany } from '../../services/hubspotClient.js';

export const hubspotCompanyAdapter = Object.freeze({
  createCompany,
  findCompanyByEmail,
  updateCompany,
});

export default hubspotCompanyAdapter;

