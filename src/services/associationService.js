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

  const contactHubspotIds = await resolveHubspotIdsFromEntries(
    sapContactIds,
    hubspotCredentialId,
    'contact'
  );

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

  const companyHubspotIds = await resolveHubspotIdsFromEntries(
    sapCompanyIds,
    hubspotCredentialId,
    'company'
  );

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

  const productLineItems = await resolveProductEntries(
    sapProducts,
    hubspotCredentialId
  );

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

async function resolveHubspotIdsFromEntries(entries, hubspotCredentialId, objectType) {
  const resolvedHubspotIds = [];

  for (const entry of entries) {
    const hubspotIdDirect = entry?.hubspotId;
    if (hubspotIdDirect) {
      resolvedHubspotIds.push(hubspotIdDirect);
      continue;
    }

    const sapId = entry?.sapId ?? entry;
    if (!sapId) {
      continue;
    }

    const hubspotId = await associationRegistryService.findHubspotIdForSapId(
      hubspotCredentialId,
      objectType,
      String(sapId)
    );

    if (hubspotId) {
      resolvedHubspotIds.push(hubspotId);
    }
  }

  return resolvedHubspotIds;
}

async function resolveProductEntries(products, hubspotCredentialId) {
  const productLineItems = [];

  for (const product of products) {
    const hubspotIdDirect = product?.hubspotId;
    const sapId = product?.sapId ?? product;

    if (!hubspotIdDirect && !sapId) {
      continue;
    }

    const hubspotId =
      hubspotIdDirect ||
      (await associationRegistryService.findHubspotIdForSapId(
        hubspotCredentialId,
        'product',
        sapId ? String(sapId) : null
      ));

    if (hubspotId) {
      productLineItems.push({
        productIdHubspot: hubspotId,
        quantity: product?.qty ?? product?.quantity ?? null,
      });
    }
  }

  return productLineItems;
}

export const associationService = {
  associateDealWithContacts,
  associateDealWithCompanies,
  associateDealWithProducts,
};

export default associationService;
