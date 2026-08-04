// Data-quality report: SAP contact rows that carry a value HubSpot enforces as
// unique (today: email) and that another SAP contact already claimed. Those rows
// cannot both exist in HubSpot -- the first one created wins and the rest answer
// 409, or 400 VALIDATION_ERROR when HubSpot resolves the row to an existing
// record before refusing the email. No code change fixes them: the duplicate has
// to be consolidated in SAP, which is what this report is for.
export const DUPLICATE_CONTACT_EMAIL_REPORT = 'sapDuplicateContactEmailReport';

function describeContact(entry) {
  const properties = entry?.contactPayload?.properties ?? {};

  return {
    sapContactId: entry?.sapInternalCode ?? null,
    sapCompanyId: entry?.company?.sapCompanyId ?? null,
    hubspotCompanyId: entry?.company?.hubspotId ?? null,
    firstname: properties.firstname ?? null,
    lastname: properties.lastname ?? null,
    phone: properties.phone ?? null,
  };
}

// `collisions` is keyed by claim key (`property:value`) so two contacts sharing
// an email land in one group instead of one row per pair.
export function buildDuplicateContactEmailReport({
  collisions,
  clientConfigId = null,
  syncLogId = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  const groups = [...(collisions?.values?.() ?? collisions ?? [])]
    .filter(({ entries }) => Array.isArray(entries) && entries.length > 1)
    .map(({ property, value, entries }) => ({
      property,
      value,
      contactCount: entries.length,
      contacts: entries.map(describeContact),
    }))
    // Worst offenders first: a value shared by five contacts needs attention
    // before one shared by two.
    .sort((a, b) => b.contactCount - a.contactCount || String(a.value).localeCompare(String(b.value)));

  if (groups.length === 0) {
    return null;
  }

  return {
    eventType: DUPLICATE_CONTACT_EMAIL_REPORT,
    payload: {
      reportType: DUPLICATE_CONTACT_EMAIL_REPORT,
      generatedAt,
      clientConfigId: clientConfigId ? String(clientConfigId) : null,
      syncLogId: syncLogId ? String(syncLogId) : null,
      objectType: 'contact',
      summary: {
        duplicatedValues: groups.length,
        // Every contact in a group, including the one that wins the create: the
        // data team needs both sides to decide which row survives.
        affectedContacts: groups.reduce((total, group) => total + group.contactCount, 0),
        properties: [...new Set(groups.map(({ property }) => property))],
      },
      duplicates: groups,
    },
  };
}

export default buildDuplicateContactEmailReport;
