function getSapContactEmail(sapContact) {
  return String(sapContact?.E_Mail ?? sapContact?.EmailAddress ?? '').trim();
}

// Builds the HubSpot payload for one company child contact. B1 contacts carry
// InternalCode + E_Mail; S/4 person-BPs carry BusinessPartner + EmailAddress.
// Email precedence: SAP contact email > mapped email > generated fallback.
export function buildCompanyContactPayload({
  mappedContact,
  sapContact,
  companyFallbackSourceEmail,
  fallbackEmailGenerator,
}) {
  const sapInternalCode = sapContact?.InternalCode ?? sapContact?.BusinessPartner;
  const contactPayload = {
    ...mappedContact,
    properties: {
      ...(mappedContact?.properties || {}),
    },
  };

  const sapContactEmail = getSapContactEmail(sapContact);

  if (sapContactEmail) {
    contactPayload.properties.email = sapContactEmail;
  }

  if (!contactPayload.properties.email) {
    const fallbackEmail = fallbackEmailGenerator(companyFallbackSourceEmail, sapInternalCode);

    if (fallbackEmail) {
      contactPayload.properties.email = fallbackEmail;
    }
  }

  return { contactPayload, sapInternalCode };
}

export default { buildCompanyContactPayload };
