import mongoose from 'mongoose';
import PanelUser from '../models/global/PanelUser.js';
import { PanelEmailTakenError } from '#domain/panel/errors.js';

const DUPLICATE_KEY_ERROR = 11000;

function toId(value) {
  return value == null ? null : String(value);
}

// Devuelve objetos planos: los casos de uso no ven documentos de Mongoose.
function toPanelUser(document) {
  if (!document) {
    return null;
  }

  return {
    id: toId(document._id),
    email: document.email,
    name: document.name,
    accountType: document.accountType,
    tenantKey: document.tenantKey ?? null,
    role: document.role ?? null,
    passwordHash: document.passwordHash,
    mustChangePassword: Boolean(document.mustChangePassword),
    active: document.active !== false,
    tokenVersion: Number(document.tokenVersion ?? 0),
    lastLoginAt: document.lastLoginAt ?? null,
    createdBy: toId(document.createdBy),
    createdAt: document.createdAt ?? null,
    updatedAt: document.updatedAt ?? null,
  };
}

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

export class MongoosePanelUserRepository {
  constructor({ model = PanelUser } = {}) {
    this.model = model;
  }

  async findByEmail(email) {
    const document = await this.model.findOne({ email }).lean();
    return toPanelUser(document);
  }

  async findById(id) {
    if (!isValidId(id)) {
      return null;
    }

    const document = await this.model.findById(id).lean();
    return toPanelUser(document);
  }

  async create(data) {
    try {
      const document = await this.model.create(data);
      return toPanelUser(document.toObject ? document.toObject() : document);
    } catch (error) {
      if (error?.code === DUPLICATE_KEY_ERROR) {
        throw new PanelEmailTakenError();
      }
      throw error;
    }
  }

  async update(id, patch) {
    if (!isValidId(id)) {
      return null;
    }

    const document = await this.model
      .findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true })
      .lean();
    return toPanelUser(document);
  }

  // Sube tokenVersion y aplica el resto del cambio en una sola operación atómica. Con
  // expectedVersion solo aplica si nadie cambió la versión mientras tanto (por ejemplo, un
  // restablecimiento de Smarteam en paralelo a un cambio de contraseña); si no, devuelve null.
  async incrementTokenVersion(id, extraPatch = {}, { expectedVersion } = {}) {
    if (!isValidId(id)) {
      return null;
    }

    const filter = { _id: id };
    if (expectedVersion !== undefined) {
      filter.tokenVersion = expectedVersion;
    }

    const update = { $inc: { tokenVersion: 1 } };
    if (Object.keys(extraPatch).length > 0) {
      update.$set = extraPatch;
    }

    const document = await this.model
      .findOneAndUpdate(filter, update, { new: true, runValidators: true })
      .lean();
    return toPanelUser(document);
  }

  async list({ tenantKey = null, page, pageSize }) {
    const filter = tenantKey ? { tenantKey } : {};
    const [documents, total] = await Promise.all([
      this.model
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      this.model.countDocuments(filter),
    ]);

    return {
      items: documents.map(toPanelUser),
      total,
    };
  }

  async touchLastLogin(id, date) {
    if (!isValidId(id)) {
      return;
    }

    await this.model.updateOne({ _id: id }, { $set: { lastLoginAt: date } });
  }
}

export default MongoosePanelUserRepository;
