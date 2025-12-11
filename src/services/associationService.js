import hubspotAuthService from './hubspotAuthService.js';
import * as hubspotClient from './hubspotClient.js';

async function getToken(hubspotCredentialId) {
  if (!hubspotCredentialId) {
    return null;
  }

  try {
    return await hubspotAuthService.getAccessToken(hubspotCredentialId);
  } catch (error) {
    console.error('Failed to retrieve HubSpot token', error);
    return null;
  }
}

async function associateDealWithContacts(hubspotCredentialId, dealId, contactIds = []) {
  const token = await getToken(hubspotCredentialId);

  if (!token || !dealId || !Array.isArray(contactIds)) {
    return { ok: true };
  }

  for (const contactId of contactIds) {
    if (!contactId) continue;

    try {
      await hubspotClient.associateObjects(token, 'deal', dealId, 'contact', contactId);
    } catch (error) {
      console.error('Failed to associate deal with contact', {
        dealId,
        contactId,
        error,
      });
    }
  }

  return { ok: true };
}

async function associateDealWithCompanies(hubspotCredentialId, dealId, companyIds = []) {
  const token = await getToken(hubspotCredentialId);

  if (!token || !dealId || !Array.isArray(companyIds)) {
    return { ok: true };
  }

  for (const companyId of companyIds) {
    if (!companyId) continue;

    try {
      await hubspotClient.associateObjects(token, 'deal', dealId, 'company', companyId);
    } catch (error) {
      console.error('Failed to associate deal with company', {
        dealId,
        companyId,
        error,
      });
    }
  }

  return { ok: true };
}

async function associateDealWithProducts(hubspotCredentialId, dealId, lineItems = []) {
  const token = await getToken(hubspotCredentialId);

  if (!token || !dealId || !Array.isArray(lineItems)) {
    return { ok: true };
  }

  for (const { productIdHubspot, quantity } of lineItems) {
    if (!productIdHubspot) continue;

    try {
      const lineItem = await hubspotClient.createLineItem(token, {
        properties: {
          hs_product_id: productIdHubspot,
          quantity,
        },
      });

      const lineItemId = lineItem?.id;
      if (!lineItemId) continue;

      await hubspotClient.associateObjects(token, 'deal', dealId, 'line_item', lineItemId);
    } catch (error) {
      console.error('Failed to associate deal with product', {
        dealId,
        productIdHubspot,
        error,
      });
    }
  }

  return { ok: true };
}

export const associationService = {
  associateDealWithContacts,
  associateDealWithCompanies,
  associateDealWithProducts,
};

export default associationService;
