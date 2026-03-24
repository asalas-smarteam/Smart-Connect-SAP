import { createMasterClientConfigModel } from '../../../models/master/ClientConfig.js';

const EDITABLE_FIELDS = [
  'clientName',
  'objectType',
  'intervalMinutes',
  'serviceLayerPath',
  'syncInTenant',
];

function normalizeServiceLayerPath(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return '';
  }

  const withoutQuery = trimmed.split('?')[0].trim();
  return `/${withoutQuery.replace(/^\/+/, '')}`;
}

function sanitizeMasterPayload(payload = {}) {
  const sanitized = {};

  for (const field of EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      sanitized[field] = payload[field];
    }
  }

  if (Object.prototype.hasOwnProperty.call(sanitized, 'clientName')) {
    sanitized.clientName = String(sanitized.clientName || '').trim();
  }

  if (Object.prototype.hasOwnProperty.call(sanitized, 'objectType')) {
    sanitized.objectType = String(sanitized.objectType || '').trim();
  }

  if (Object.prototype.hasOwnProperty.call(sanitized, 'serviceLayerPath')) {
    sanitized.serviceLayerPath = normalizeServiceLayerPath(sanitized.serviceLayerPath);
  }

  if (Object.prototype.hasOwnProperty.call(sanitized, 'intervalMinutes')) {
    const interval = Number(sanitized.intervalMinutes);
    if (!Number.isFinite(interval) || interval <= 0) {
      throw new Error('intervalMinutes must be a positive number');
    }

    if (interval === 5) {
      throw new Error('intervalMinutes = 5 is not allowed in master ClientConfig');
    }

    sanitized.intervalMinutes = interval;
  }

  if (Object.prototype.hasOwnProperty.call(sanitized, 'syncInTenant')) {
    sanitized.syncInTenant = Boolean(sanitized.syncInTenant);
  }

  sanitized.active = false;

  return sanitized;
}

function ensureRequiredForCreate(payload) {
  const required = ['clientName', 'objectType', 'intervalMinutes', 'serviceLayerPath'];
  const missing = required.filter((field) => !payload[field]);

  if (missing.length) {
    throw new Error(`Missing required fields: ${missing.join(', ')}`);
  }
}

export async function listMasterClientConfigs(masterConnection) {
  const MasterClientConfig = createMasterClientConfigModel(masterConnection);
  return MasterClientConfig.find({}).sort({ clientName: 1 }).lean();
}

export async function createMasterClientConfig(masterConnection, payload) {
  const MasterClientConfig = createMasterClientConfigModel(masterConnection);
  const sanitized = sanitizeMasterPayload(payload);
  ensureRequiredForCreate(sanitized);

  return MasterClientConfig.create(sanitized);
}

export async function patchMasterClientConfig(masterConnection, id, payload) {
  const MasterClientConfig = createMasterClientConfigModel(masterConnection);
  const config = await MasterClientConfig.findById(id);

  if (!config) {
    return null;
  }

  const sanitized = sanitizeMasterPayload(payload);
  delete sanitized._id;

  Object.assign(config, sanitized);
  await config.save();

  return config;
}

export async function deleteMasterClientConfig(masterConnection, id) {
  const MasterClientConfig = createMasterClientConfigModel(masterConnection);
  return MasterClientConfig.findByIdAndDelete(id);
}
