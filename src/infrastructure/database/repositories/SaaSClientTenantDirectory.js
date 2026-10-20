import { SaaSClient } from '../master/database.js';

// Lectura de las empresas para el panel. Solo proyecta tenantKey, companyName y status: el
// SaaSClient guarda también tokens de HubSpot, que nunca deben salir hacia el panel.
const PUBLIC_FIELDS = 'tenantKey companyName status';

function toTenant(document) {
  if (!document) {
    return null;
  }

  return {
    tenantKey: document.tenantKey,
    companyName: document.companyName ?? null,
    status: document.status ?? null,
  };
}

export class SaaSClientTenantDirectory {
  constructor({ model = SaaSClient } = {}) {
    this.model = model;
  }

  async findByKey(tenantKey) {
    if (!tenantKey) {
      return null;
    }

    const document = await this.model.findOne({ tenantKey }).select(PUBLIC_FIELDS).lean();
    return toTenant(document);
  }

  async findManyByKeys(tenantKeys = []) {
    const keys = [...new Set(tenantKeys.filter(Boolean))];
    if (keys.length === 0) {
      return [];
    }

    const documents = await this.model
      .find({ tenantKey: { $in: keys } })
      .select(PUBLIC_FIELDS)
      .lean();
    return documents.map(toTenant);
  }

  async listAll() {
    const documents = await this.model
      .find({})
      .select(PUBLIC_FIELDS)
      .sort({ companyName: 1 })
      .lean();
    return documents.map(toTenant);
  }
}

export default SaaSClientTenantDirectory;
