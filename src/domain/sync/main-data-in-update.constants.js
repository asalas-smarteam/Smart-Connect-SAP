export const MAIN_DATA_IN_UPDATE = Object.freeze({
  HUBSPOT: 'HUBSPOT',
  SAP: 'SAP',
});

export const DEFAULT_MAIN_DATA_IN_UPDATE = MAIN_DATA_IN_UPDATE.HUBSPOT;

export function normalizeMainDataInUpdate(value) {
  const normalized = String(value ?? DEFAULT_MAIN_DATA_IN_UPDATE)
    .trim()
    .toUpperCase();

  return normalized === MAIN_DATA_IN_UPDATE.SAP
    ? MAIN_DATA_IN_UPDATE.SAP
    : DEFAULT_MAIN_DATA_IN_UPDATE;
}

export function shouldUpdateSapFromHubspot({ mainDataInUpdate, objectType }) {
  return (
    normalizeMainDataInUpdate(mainDataInUpdate) === MAIN_DATA_IN_UPDATE.SAP
    && ['contact', 'company'].includes(objectType)
  );
}
