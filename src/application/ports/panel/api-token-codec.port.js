import { createPort } from '../port-validator.js';

// Genera y hashea tokens personales del panel (contrato 12, M2).
//   generate()   → { token, hash, prefix }: token 'spn_' + 43 base64url (32 bytes aleatorios),
//                  hash = SHA-256 en hex del token completo, prefix = primeros 8 caracteres
//   hash(value)  → SHA-256 en hex del texto (para buscar por findByHash)
// El token en claro no se guarda en ningún lado: solo sale en la respuesta de creación.
export const ApiTokenCodecPort = createPort({
  name: 'ApiTokenCodecPort',
  methods: [
    'generate',
    'hash',
  ],
});
