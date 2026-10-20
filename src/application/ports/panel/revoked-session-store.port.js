import { createPort } from '../port-validator.js';

// Sesiones del panel cerradas con logout antes de vencer. revoke es idempotente y devuelve true
// solo si esa llamada la revocó.
export const RevokedSessionStorePort = createPort({
  name: 'RevokedSessionStorePort',
  methods: [
    'revoke',
    'isRevoked',
  ],
});
