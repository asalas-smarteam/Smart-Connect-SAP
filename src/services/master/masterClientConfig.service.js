import { createMasterClientConfigModel } from '../../../models/master/ClientConfig.js';

const EDITABLE_FIELDS = [
  'clientName',
  'objectType',
  'mode',
  'intervalMinutes',
  'executionTime',
  'serviceLayerPath',
  'syncInTenant',
];

const ALLOWED_MODES = new Set(['FULL', 'INCREMENTAL']);
const ALLOWED_INCREMENTAL_INTERVALS = new Set([5, 10, 15, 20, 30]);

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

  if (Object.prototype.hasOwnProperty.call(sanitized, 'mode')) {
    sanitized.mode = String(sanitized.mode || '').trim().toUpperCase();
    if (!ALLOWED_MODES.has(sanitized.mode)) {
      throw new Error('mode must be FULL or INCREMENTAL');
    }
  }

  if (Object.prototype.hasOwnProperty.call(sanitized, 'intervalMinutes')) {
    const interval = Number(sanitized.intervalMinutes);
    if (!Number.isFinite(interval) || !ALLOWED_INCREMENTAL_INTERVALS.has(interval)) {
      throw new Error('intervalMinutes must be one of: 5, 10, 15, 20, 30');
    }

    sanitized.intervalMinutes = interval;
  }

  if (Object.prototype.hasOwnProperty.call(sanitized, 'executionTime')) {
    sanitized.executionTime = String(sanitized.executionTime || '').trim();
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(sanitized.executionTime)) {
      throw new Error('executionTime must use HH:mm format');
    }
  }

  if (Object.prototype.hasOwnProperty.call(sanitized, 'syncInTenant')) {
    sanitized.syncInTenant = Boolean(sanitized.syncInTenant);
  }

  sanitized.active = false;

  return sanitized;
}

function ensureRequiredForCreate(payload) {
  const required = ['clientName', 'objectType', 'serviceLayerPath'];
  const mode = payload.mode || 'INCREMENTAL';

  if (mode === 'FULL') {
    required.push('executionTime');
  } else {
    required.push('intervalMinutes');
  }

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
