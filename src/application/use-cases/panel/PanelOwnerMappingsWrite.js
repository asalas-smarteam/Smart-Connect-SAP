import { toOwnerMappingView } from '#domain/panel/ownerMappingView.js';
import { checkOwnerMappingPatch, diffOwnerMapping, EDITABLE_OWNER_FIELDS } from '#domain/panel/ownerMappingEdit.js';
import { fail, panelReasons, validationError } from './panelReasons.js';
import { resolveScopeTenant } from './tenantScope.js';

const STALE_MESSAGE = 'Otra persona cambió este responsable. Recarga la lista para ver los valores actuales.';
const ERP_OWNER_TAKEN_MESSAGE = 'Ese código de vendedor ya está asignado a otro responsable.';
const CRM_UNAVAILABLE_MESSAGE = 'No se pudo consultar el CRM. Intenta de nuevo más tarde.';
const NO_CREDENTIAL_MESSAGE = 'La empresa no tiene una conexión activa con el CRM.';
const TOO_MANY_REQUESTS_MESSAGE = 'Ya se actualizaron los responsables hace poco. Intenta de nuevo en un minuto.';
const SYNC_RETRY_AFTER_SECONDS = 60;

const COLUMN_BY_FIELD = EDITABLE_OWNER_FIELDS;

function sameInstant(left, right) {
  if (!left || !right) {
    return false;
  }
  const a = left instanceof Date ? left : new Date(left);
  const b = right instanceof Date ? right : new Date(right);
  return !Number.isNaN(a.getTime()) && a.getTime() === b.getTime();
}

function textOrNull(value) {
  return value === undefined || value === null ? null : String(value);
}

function changedBy(user) {
  return {
    userId: user?.id === undefined || user?.id === null ? null : String(user.id),
    name: user?.name ?? null,
    email: user?.email ?? null,
    accountType: user?.accountType ?? null,
  };
}

// Edición del mapeo de responsables desde el panel (plan 12, contrato 14, O2 a O4). Solo los dos
// códigos del ERP y la carga bajo demanda de los responsables del CRM; no crea a mano ni borra.
// No usa ManageOwnerMappings (API admin): ese toma la credencial del cuerpo y no valida.
export class PanelOwnerMappingsWrite {
  constructor({
    ownerMappingWriter,
    crmOwnerDirectory,
    tenantDirectory,
    syncAttempts = null,
    logger = null,
    now = () => new Date(),
  }) {
    this.writer = ownerMappingWriter;
    this.crm = crmOwnerDirectory;
    this.tenantDirectory = tenantDirectory;
    this.syncAttempts = syncAttempts;
    this.logger = logger;
    this.now = now;
  }

  // O2. Respuesta: la fila con la vista de N2.
  async update({ scope, id, body }) {
    const tenant = await resolveScopeTenant(this.tenantDirectory, scope);
    if (!tenant.ok) {
      return tenant;
    }
    const { tenantKey } = tenant;

    const patch = checkOwnerMappingPatch(body);
    if (!patch.ok) {
      return validationError(patch.message);
    }

    const current = await this.writer.findById(tenantKey, id);
    if (!current) {
      return fail(panelReasons.NOT_FOUND);
    }
    if (!sameInstant(current.updatedAt, patch.expectedUpdatedAt)) {
      return fail(panelReasons.STALE_UPDATE, STALE_MESSAGE);
    }

    const changes = diffOwnerMapping(current, patch.set);
    if (changes.length === 0) {
      return { ok: true, data: toOwnerMappingView(current) };
    }

    const set = Object.fromEntries(changes.map((change) => [COLUMN_BY_FIELD[change.field], change.to]));
    let updated;
    try {
      updated = await this.writer.updateErpCodes(tenantKey, id, { expectedUpdatedAt: patch.expectedUpdatedAt, set });
    } catch (error) {
      if (error?.code === 'ERP_OWNER_TAKEN') {
        return fail(panelReasons.ERP_OWNER_TAKEN, ERP_OWNER_TAKEN_MESSAGE);
      }
      throw error;
    }
    if (!updated) {
      const stillThere = await this.writer.findById(tenantKey, id);
      return stillThere ? fail(panelReasons.STALE_UPDATE, STALE_MESSAGE) : fail(panelReasons.NOT_FOUND);
    }

    await this.#appendHistory(tenantKey, {
      mappingId: String(updated._id ?? current._id),
      crmOwnerId: textOrNull(updated.hubspotOwnerId ?? current.hubspotOwnerId),
      action: 'updated',
      changedBy: changedBy(scope?.user),
      changedAt: this.now(),
      changes,
    });

    return { ok: true, data: toOwnerMappingView(updated) };
  }

  // O3. Respuesta: { added, updated, total }.
  async sync({ scope }) {
    const tenant = await resolveScopeTenant(this.tenantDirectory, scope);
    if (!tenant.ok) {
      return tenant;
    }
    const { tenantKey } = tenant;

    if (this.syncAttempts) {
      const limit = await this.syncAttempts.consume(tenantKey);
      if (limit?.blocked) {
        return fail(panelReasons.TOO_MANY_REQUESTS, TOO_MANY_REQUESTS_MESSAGE, { retryAfterSeconds: SYNC_RETRY_AFTER_SECONDS });
      }
    }

    const credentials = await this.crm.listCredentials(tenantKey);
    if (!credentials?.length) {
      return fail(panelReasons.CRM_UNAVAILABLE, NO_CREDENTIAL_MESSAGE);
    }

    const user = changedBy(scope?.user);
    let added = 0;
    let updated = 0;
    let failedCredentials = 0;

    for (const credential of credentials) {
      // Primero la lista completa del CRM: si falla, de esta credencial no se inserta nada.
      let owners;
      try {
        // eslint-disable-next-line no-await-in-loop
        owners = await this.crm.fetchOwners(tenantKey, credential.id);
      } catch (error) {
        failedCredentials += 1;
        this.logger?.warn?.({
          msg: 'Panel owner mappings sync: CRM unavailable for credential',
          tenantKey,
          credentialId: credential.id,
          status: error?.details?.status ?? error?.response?.status ?? null,
          error: error?.message,
        });
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const existing = await this.writer.listByCredential(tenantKey, credential.id);
      const byOwnerId = new Map(existing.map((row) => [String(row.hubspotOwnerId), row]));

      for (const owner of owners ?? []) {
        const ownerId = textOrNull(owner?.hubspotOwnerId);
        if (!ownerId) {
          continue;
        }
        const name = owner.hubspotOwnerName ?? null;
        const email = owner.hubspotOwnerEmail ?? null;
        const row = byOwnerId.get(ownerId);

        if (!row) {
          // eslint-disable-next-line no-await-in-loop
          const inserted = await this.writer.insertSeeded(tenantKey, {
            hubspotCredentialId: credential.id,
            hubspotOwnerId: ownerId,
            hubspotOwnerName: name,
            hubspotOwnerEmail: email,
          });
          // Marca el id como visto aunque haya sido una carrera: un duplicado en la lista del
          // CRM no se intenta insertar dos veces.
          byOwnerId.set(ownerId, inserted ?? { hubspotOwnerId: ownerId, hubspotOwnerName: name, hubspotOwnerEmail: email });
          if (inserted) {
            added += 1;
            // eslint-disable-next-line no-await-in-loop
            await this.#appendHistory(tenantKey, {
              mappingId: String(inserted._id),
              crmOwnerId: ownerId,
              action: 'synced_created',
              changedBy: user,
              changedAt: this.now(),
              changes: [],
            });
          }
          continue;
        }

        if ((row.hubspotOwnerName ?? null) !== name || (row.hubspotOwnerEmail ?? null) !== email) {
          if (row._id) {
            // eslint-disable-next-line no-await-in-loop
            await this.writer.refreshCrmOwnerData(tenantKey, row._id, { hubspotOwnerName: name, hubspotOwnerEmail: email });
            updated += 1;
          }
          byOwnerId.set(ownerId, { ...row, hubspotOwnerName: name, hubspotOwnerEmail: email });
        }
      }
    }

    if (failedCredentials > 0) {
      this.logger?.warn?.({ msg: 'Panel owner mappings sync: partial result', tenantKey, added, updated, failedCredentials });
      return fail(panelReasons.CRM_UNAVAILABLE, CRM_UNAVAILABLE_MESSAGE);
    }

    const total = await this.writer.countAll(tenantKey);
    return { ok: true, data: { added, updated, total } };
  }

  // El historial va después de la escritura y no la revierte: si falla, se loguea con lo justo
  // para reconstruirlo (sin datos personales) y la respuesta sigue siendo 200.
  async #appendHistory(tenantKey, entry) {
    try {
      await this.writer.appendHistory(tenantKey, entry);
    } catch (error) {
      this.logger?.error?.({
        msg: 'Panel owner mappings: history write failed',
        tenantKey,
        mappingId: entry.mappingId,
        action: entry.action,
        error: error?.message,
      });
    }
  }
}

export default PanelOwnerMappingsWrite;
