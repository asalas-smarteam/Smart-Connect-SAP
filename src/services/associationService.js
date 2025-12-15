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

async function associateObjectsBySapId(
  token,
  hubspotCredentialId,
  fromObjectType,
  fromHubspotId,
  toObjectType,
  sapEntries = []
) {
  const resolvedToken = await resolveToken(token, hubspotCredentialId);

  if (
    !resolvedToken ||
    !fromHubspotId ||
    !fromObjectType ||
    !toObjectType ||
    !Array.isArray(sapEntries)
  ) {
    return { ok: true };
  }

  const toHubspotIds = await resolveHubspotIdsFromEntries(
    sapEntries,
    hubspotCredentialId,
    toObjectType
  );

  for (const toHubspotId of toHubspotIds) {
    try {
      await hubspotClient.associateObjects(
        resolvedToken,
        fromObjectType,
        fromHubspotId,
        toObjectType,
        toHubspotId
      );
    } catch (error) {
      console.error('Failed to associate objects', {
        fromObjectType,
        fromHubspotId,
        toObjectType,
        toHubspotId,
        error,
      });
    }
  }

  return { ok: true };
}

async function associateDealWithContacts(
  token,
  hubspotCredentialId,
  dealId,
  sapContactIds = []
) {
  return associateObjectsBySapId(
    token,
    hubspotCredentialId,
    'deal',
    dealId,
    'contact',
    sapContactIds
  );
}

async function associateDealWithCompanies(
  token,
  hubspotCredentialId,
  dealId,
  sapCompanyIds = []
) {
  return associateObjectsBySapId(
    token,
    hubspotCredentialId,
    'deal',
    dealId,
    'company',
    sapCompanyIds
  );
}

async function associateContactWithCompanies(
  token,
  hubspotCredentialId,
  contactId,
  sapCompanyIds = []
) {
  return associateObjectsBySapId(
    token,
    hubspotCredentialId,
    'contact',
    contactId,
    'company',
    sapCompanyIds
  );
}

async function associateCompanyWithContacts(
  token,
  hubspotCredentialId,
  companyId,
  sapContactIds = []
) {
  return associateObjectsBySapId(
    token,
    hubspotCredentialId,
    'company',
    companyId,
    'contact',
    sapContactIds
  );
}

export const associationService = {
  associateDealWithContacts,
  associateDealWithCompanies,
  associateDealWithProducts,
  associateContactWithCompanies,
  associateCompanyWithContacts,
  associateObjectsBySapId,
};

export default associationService;
