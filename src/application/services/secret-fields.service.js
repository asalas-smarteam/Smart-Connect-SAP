// Secretos guardados en configuraciones de tenant (tokens de API, contraseñas de SAP y de bases
// externas). La API de administración nunca los devuelve: muestra la máscara si hay un valor
// guardado y null si no, así se sabe si está configurado sin ver cuál es.
//
// Se enmascara solo en la salida de los casos de uso que sirven a la API. Los repositorios
// siguen devolviendo el valor real porque la sync y las conexiones externas lo necesitan.
export const SECRET_MASK = '********';

function toPlain(record) {
  return typeof record?.toJSON === 'function' ? record.toJSON() : record;
}

export function maskSecretFields(record, fields) {
  if (record === null || record === undefined) {
    return record;
  }

  const plain = { ...toPlain(record) };
  fields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(plain, field)) {
      plain[field] = plain[field] ? SECRET_MASK : null;
    }
  });
  return plain;
}

// Un GET seguido de un PATCH con el objeto completo devuelve la máscara en cada secreto. Si se
// guardara tal cual, reemplazaría la contraseña real por '********' y cortaría la sync de ese
// tenant. Por eso un secreto que llega con la máscara se descarta y conserva su valor guardado.
// Cualquier otro valor, incluido el vacío, se respeta: así se puede cambiar o borrar a propósito.
export function dropMaskedSecrets(payload, fields) {
  const cleaned = { ...payload };
  fields.forEach((field) => {
    if (cleaned[field] === SECRET_MASK) {
      delete cleaned[field];
    }
  });
  return cleaned;
}
