// Vista de un mapeo de responsables (OwnerMappings) para el panel (plan 11, contrato 13, N2).
// Igual para cliente y Smarteam. Los valores van tal cual están en la base, con nombres de campo
// genéricos. Nunca expone hubspotCredentialId ni __v. Campo ausente → null.

const SYSTEM_NAMES = [
  [/hubspot/gi, 'crm'],
  [/sap/gi, 'erp'],
];

function value(raw, name) {
  return raw[name] === undefined ? null : raw[name];
}

function text(raw, name) {
  const current = value(raw, name);
  return current === null ? null : String(current);
}

function toIso(current) {
  if (!current) {
    return null;
  }
  const date = current instanceof Date ? current : new Date(current);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// hubspot_seed → crm_seed; los demás valores tal cual, salvo que nombren un sistema.
export function genericSource(source) {
  if (source === undefined || source === null) {
    return null;
  }
  let result = String(source);
  for (const [pattern, replacement] of SYSTEM_NAMES) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function toOwnerMappingView(raw) {
  if (!raw) {
    return null;
  }
  const id = raw._id ?? raw.id;
  return {
    id: id === undefined || id === null ? null : String(id),
    crmOwnerId: text(raw, 'hubspotOwnerId'),
    crmOwnerName: value(raw, 'hubspotOwnerName'),
    crmOwnerEmail: value(raw, 'hubspotOwnerEmail'),
    // Vendedor y empleado del ERP: tal cual (en la base son texto y pueden ser varios códigos
    // separados por coma, "113,758,864"; documentos viejos pueden tener número).
    erpOwnerId: value(raw, 'sapOwnerId'),
    erpOwnerName: value(raw, 'sapOwnerName'),
    erpEmployeeId: value(raw, 'sapOwnerId_2'),
    active: typeof raw.active === 'boolean' ? raw.active : null,
    source: genericSource(raw.source),
    createdAt: toIso(raw.createdAt),
    updatedAt: toIso(raw.updatedAt),
  };
}
