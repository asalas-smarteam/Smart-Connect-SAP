import { createPort } from '../port-validator.js';

// Tokens personales del panel (contrato 12, M2 y M7), en la base master (PanelApiTokens).
// Registro = { id, userId, name, prefix, createdAt, expiresAt, lastUsedAt, revokedAt,
// revokedReason }, con ids en texto. Ningún método devuelve tokenHash ni el token en claro: el
// token solo existe en la respuesta de creación, la arma el caso de uso con el codec.
// Activo = revokedAt null y expiresAt > now.
//   create({ userId, name, tokenHash, prefix, createdAt, expiresAt })  guarda y devuelve el
//                                  registro (lastUsedAt, revokedAt y revokedReason en null)
//   listActiveByUser(userId, now)  registros activos del usuario, createdAt descendente
//   countActiveByUser(userId, now) cuántos activos tiene el usuario (número)
//   findByHash(tokenHash)          registro (activo o no) o null; el caso de uso decide
//   revoke({ userId, id, reason, at })  revoca solo si es del usuario y revokedAt es null;
//                                  devuelve el registro revocado o null (id inválido,
//                                  inexistente, de otro usuario o ya revocado)
//   revokeAllForUser({ userId, reason, at })  revoca todos los no revocados del usuario
//                                  (incluso vencidos) y devuelve solo los que esta llamada revocó
//   touchLastUsed(id, at)          escribe lastUsedAt = at si estaba vacío o tiene más de 60 s;
//                                  true si escribió
export const ApiTokenRepositoryPort = createPort({
  name: 'ApiTokenRepositoryPort',
  methods: [
    'create',
    'listActiveByUser',
    'countActiveByUser',
    'findByHash',
    'revoke',
    'revokeAllForUser',
    'touchLastUsed',
  ],
});
