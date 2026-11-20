import { getPanelTenantModels } from './panelTenantModels.js';

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const DUPLICATE_KEY = 11000;
const CRM_OWNER_FIELDS = Object.freeze({ _id: 1, hubspotOwnerId: 1, hubspotOwnerName: 1, hubspotOwnerEmail: 1 });

function isObjectId(id) {
  return typeof id === 'string' ? OBJECT_ID.test(id) : Boolean(id && OBJECT_ID.test(String(id)));
}

function isDuplicateKey(error) {
  return error?.code === DUPLICATE_KEY;
}

// Error que el caso de uso traduce a 409 erp_owner_taken: el índice único
// uniq_sap_owner_mapping_partial ya tiene ese vendedor en otra fila de la misma credencial.
// Se eligió lanzar (y no devolver un marcador) para que null siga significando solo "no
// coincidió la versión o la fila no existe".
export class ErpOwnerTakenError extends Error {
  constructor() {
    super('ERP owner code already mapped for this CRM credential');
    this.name = 'ErpOwnerTakenError';
    this.code = 'ERP_OWNER_TAKEN';
  }
}

// Escritura del mapeo de responsables desde el panel (plan 12, contrato 14). Usa el modelo
// OwnerMapping del núcleo (mismo schema e índices) a través de getPanelTenantModels, sin tocar
// el registro central de modelos de tenant ni ManageOwnerMappings.
export class MongooseOwnerMappingWriter {
  constructor({ getModels = getPanelTenantModels } = {}) {
    this.getModels = getModels;
    this.historyIndexesReady = new Map();
  }

  async findById(tenantKey, id) {
    if (!isObjectId(id)) {
      return null;
    }
    const { OwnerMapping } = await this.getModels(tenantKey);
    return OwnerMapping.findById(String(id)).lean();
  }

  // Filtro por _id y updatedAt: atómico frente a otro editor. Los timestamps de Mongoose mueven
  // updatedAt. null si la versión no coincide o la fila no existe.
  async updateErpCodes(tenantKey, id, { expectedUpdatedAt, set }) {
    if (!isObjectId(id)) {
      return null;
    }
    const { OwnerMapping } = await this.getModels(tenantKey);
    try {
      return await OwnerMapping.findOneAndUpdate(
        { _id: String(id), updatedAt: expectedUpdatedAt },
        { $set: set },
        { new: true, lean: true, runValidators: true }
      );
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw new ErpOwnerTakenError();
      }
      throw error;
    }
  }

  async listByCredential(tenantKey, credentialId) {
    if (!isObjectId(credentialId)) {
      return [];
    }
    const { OwnerMapping } = await this.getModels(tenantKey);
    return OwnerMapping.find({ hubspotCredentialId: String(credentialId) }, CRM_OWNER_FIELDS).lean();
  }

  // Igual que el seed del CRM (tenantHubspotSeed.service.js). Un E11000 (otra sincronización
  // la insertó primero) se toma como "ya existía": null.
  async insertSeeded(tenantKey, { hubspotCredentialId, hubspotOwnerId, hubspotOwnerName, hubspotOwnerEmail }) {
    const { OwnerMapping } = await this.getModels(tenantKey);
    try {
      const created = await OwnerMapping.create({
        hubspotCredentialId: String(hubspotCredentialId),
        hubspotOwnerId: String(hubspotOwnerId),
        hubspotOwnerName: hubspotOwnerName ?? null,
        hubspotOwnerEmail: hubspotOwnerEmail ?? null,
        sapOwnerId: null,
        sapOwnerId_2: null,
        sapOwnerName: null,
        active: true,
        source: 'hubspot_seed',
      });
      return typeof created?.toObject === 'function' ? created.toObject() : created;
    } catch (error) {
      if (isDuplicateKey(error)) {
        return null;
      }
      throw error;
    }
  }

  // Solo nombre y correo del CRM, sin mover updatedAt: un refresco no debe dar stale_update a
  // quien está editando esa fila.
  async refreshCrmOwnerData(tenantKey, id, { hubspotOwnerName, hubspotOwnerEmail }) {
    if (!isObjectId(id)) {
      return;
    }
    const { OwnerMapping } = await this.getModels(tenantKey);
    await OwnerMapping.updateOne(
      { _id: String(id) },
      { $set: { hubspotOwnerName: hubspotOwnerName ?? null, hubspotOwnerEmail: hubspotOwnerEmail ?? null } },
      { timestamps: false }
    );
  }

  async countAll(tenantKey) {
    const { OwnerMapping } = await this.getModels(tenantKey);
    return OwnerMapping.countDocuments({});
  }

  // Índices y colección del historial se crean con el primer documento del tenant.
  async ensureHistoryIndexes(tenantKey, OwnerMappingHistory) {
    if (!this.historyIndexesReady.has(tenantKey)) {
      const pending = OwnerMappingHistory.createIndexes().catch((error) => {
        this.historyIndexesReady.delete(tenantKey);
        throw error;
      });
      this.historyIndexesReady.set(tenantKey, pending);
    }
    await this.historyIndexesReady.get(tenantKey);
  }

  async appendHistory(tenantKey, entry) {
    const { OwnerMappingHistory } = await this.getModels(tenantKey);
    await this.ensureHistoryIndexes(tenantKey, OwnerMappingHistory);
    await OwnerMappingHistory.create(entry);
  }
}

export default MongooseOwnerMappingWriter;
