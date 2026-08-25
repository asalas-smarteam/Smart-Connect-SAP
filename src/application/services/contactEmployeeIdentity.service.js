// Regla de identidad de los ContactEmployees frente al email único de HubSpot.
//
// HubSpot fuerza email único en contacts, pero en SAP es normal que dos
// ContactEmployees del mismo BP compartan correo (recepción, facturación...).
// La llave real de un CE es su InternalCode: cuando el email limpio ya tiene
// dueño, el CE se envía como localpart+InternalCode@domain y el dueño lo
// conserva. Vive en un servicio puro por la misma razón que
// mappingValueResolver: los caminos secuencial y batch consumen LA MISMA regla
// (duplicarla inline es el bug que ya se pagó con el mapeo de campos).
import { normalizeIndexKey } from './crmObjectIndex.service.js';

// recepcion@tecnopack.net + 91643 -> recepcion+91643@tecnopack.net.
// Misma validación de base que generateFallbackEmail (email.utils.js): si el
// email o el código no sirven devuelve null y el caller conserva el original.
export function plusAddressEmail(email, internalCode) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const code = String(internalCode ?? '').trim();

  if (!code || !normalizedEmail.includes('@')) {
    return null;
  }

  const [localPart, domain] = normalizedEmail.split('@');

  if (!localPart || !domain) {
    return null;
  }

  return `${localPart}+${code}@${domain}`;
}

// Decide el email final de UN ContactEmployee.
//
// - Sin dueño y sin reclamo en la corrida -> el email original, intacto.
// - Dueño (o reclamo) con el MISMO internalcode -> intacto: es él mismo.
// - Cualquier otro dueño (otro internalcode, un contacto sin internalcode, el
//   BP padre, otro CE anterior de la corrida) -> plus addressing.
// - Si el plus no se puede construir (código vacío, email inválido) se
//   devuelve el original: mejor el colapso viejo que inventar un email.
//
// `claimedEmails` existe porque la Search API es eventualmente consistente:
// un contacto creado hace segundos puede no aparecer en la búsqueda, así que
// los gemelos de la MISMA corrida se resuelven en memoria.
export function resolveContactEmployeeEmail({
  email,
  internalCode,
  owner = null,
  claimedEmails = new Map(),
}) {
  const emailKey = normalizeIndexKey(email);
  const codeKey = normalizeIndexKey(internalCode);

  if (!emailKey) {
    return email;
  }

  const claimedBy = claimedEmails.get(emailKey);

  if (claimedBy !== undefined) {
    if (codeKey && claimedBy === codeKey) {
      return email;
    }
    return plusAddressEmail(email, internalCode) ?? email;
  }

  if (!owner) {
    return email;
  }

  const ownerCode = normalizeIndexKey(owner.internalcode);

  if (codeKey && ownerCode === codeKey) {
    return email;
  }

  return plusAddressEmail(email, internalCode) ?? email;
}

// First-claim-wins: el primer CE que reclama un email es su dueño en la
// corrida; los siguientes con otro código reciben el plus.
export function claimEmail(claimedEmails, email, internalCode) {
  const emailKey = normalizeIndexKey(email);

  if (emailKey && !claimedEmails.has(emailKey)) {
    claimedEmails.set(emailKey, normalizeIndexKey(internalCode));
  }
}

export default {
  plusAddressEmail,
  resolveContactEmployeeEmail,
  claimEmail,
};
