import hubspotAuthService from './hubspotAuthService.js';
import associationRegistryService from './associationRegistryService.js';
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

async function resolveToken(token, hubspotCredentialId) {
  if (token) return token;
  return getToken(hubspotCredentialId);
}

async function associateDealWithContacts(
  token,
  hubspotCredentialId,
  dealId,
  sapContactIds = []
) {
  const resolvedToken = await resolveToken(token, hubspotCredentialId);

  if (!resolvedToken || !dealId || !Array.isArray(sapContactIds)) {
    return { ok: true };
  }

  const contactHubspotIds = [];
  for (const sapContactId of sapContactIds) {
    const hubspotIdResolved = await associationRegistryService.findHubspotIdForSapId(
      hubspotCredentialId,
      'contact',
      String(sapContactId)
    );

    if (hubspotIdResolved) {
      contactHubspotIds.push(hubspotIdResolved);
    }
  }

  for (const contactId of contactHubspotIds) {
    try {
      await hubspotClient.associateObjects(
        resolvedToken,
        'deal',
        dealId,
        'contact',
        contactId
      );
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

async function associateDealWithCompanies(
  token,
  hubspotCredentialId,
  dealId,
  sapCompanyIds = []
) {
  const resolvedToken = await resolveToken(token, hubspotCredentialId);

  if (!resolvedToken || !dealId || !Array.isArray(sapCompanyIds)) {
    return { ok: true };
  }

  const companyHubspotIds = [];
  for (const sapCompanyId of sapCompanyIds) {
    const hubspotIdResolved = await associationRegistryService.findHubspotIdForSapId(
      hubspotCredentialId,
      'company',
      String(sapCompanyId)
    );

    if (hubspotIdResolved) {
      companyHubspotIds.push(hubspotIdResolved);
    }
  }

  for (const companyId of companyHubspotIds) {
    try {
      await hubspotClient.associateObjects(
        resolvedToken,
        'deal',
        dealId,
        'company',
        companyId
      );
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

async function associateDealWithProducts(
  token,
  hubspotCredentialId,
  dealId,
  sapProducts = []
) {
  const resolvedToken = await resolveToken(token, hubspotCredentialId);

  if (!resolvedToken || !dealId || !Array.isArray(sapProducts)) {
    return { ok: true };
  }

  const productLineItems = [];
  for (const sapProduct of sapProducts) {
    const sapProductId = sapProduct?.sapId ?? sapProduct;

    const hubspotIdResolved = await associationRegistryService.findHubspotIdForSapId(
      hubspotCredentialId,
      'product',
      String(sapProductId)
    );

    if (hubspotIdResolved) {
      productLineItems.push({
        productIdHubspot: hubspotIdResolved,
        quantity: sapProduct?.qty ?? sapProduct?.quantity ?? null,
      });
    }
  }

  for (const { productIdHubspot, quantity } of productLineItems) {
    if (!productIdHubspot) continue;

    try {
      const properties = { hs_product_id: productIdHubspot };

      if (quantity !== undefined && quantity !== null) {
        properties.quantity = quantity;
      }

      const lineItem = await hubspotClient.createLineItem(resolvedToken, {
        properties,
      });

      const lineItemId = lineItem?.id;
      if (!lineItemId) continue;

      await hubspotClient.associateObjects(
        resolvedToken,
        'deal',
        dealId,
        'line_item',
        lineItemId
      );
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
