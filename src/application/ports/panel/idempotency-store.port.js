import { createPort } from '../port-validator.js';

// Registro de claves Idempotency-Key del registro de trabajo (contrato 12, M5), en la base
// master (PanelIdempotencyKeys). Guarda solo lo necesario para reconocer la clave y encontrar la
// entrada: nunca el resumen, la nota interna ni el cuerpo de la respuesta.
// Registro = { ownerKey, key, fingerprint, state, tenantKey, ticketId, entryId, status,
// createdAt, expiresAt }; ownerKey = 'token:<id>' o 'user:<id>'; state = 'pending' o 'done'.
//   find({ ownerKey, key, now })   registro vigente (expiresAt > now; now es opcional, por
//                                  defecto la hora actual) o null
//   reserve({ ownerKey, key, fingerprint, at })  inserta { state: 'pending', createdAt: at,
//                                  expiresAt: at + 24 h }; devuelve el registro, o null si la
//                                  clave ya existe (índice único: otro request se adelantó)
//   takeOver({ ownerKey, key, fingerprint, staleBefore, at })  retoma un pending abandonado:
//                                  solo si sigue pending, con esa huella y createdAt <
//                                  staleBefore; pone createdAt = at (expiresAt no cambia).
//                                  Registro o null (otro lo retomó o ya no aplica)
//   complete({ ownerKey, key, createdAt, tenantKey, ticketId, entryId, status })  pasa a 'done'
//                                  solo si sigue pending con ese createdAt (la reserva propia);
//                                  true si escribió
//   release({ ownerKey, key, createdAt })  borra la reserva propia si sigue pending con ese
//                                  createdAt (el request terminó en 4xx o 5xx)
export const IdempotencyStorePort = createPort({
  name: 'IdempotencyStorePort',
  methods: [
    'find',
    'reserve',
    'takeOver',
    'complete',
    'release',
  ],
});
