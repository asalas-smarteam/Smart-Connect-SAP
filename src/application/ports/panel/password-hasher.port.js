import { createPort } from '../port-validator.js';

export const PasswordHasherPort = createPort({
  name: 'PasswordHasherPort',
  methods: [
    'hash',
    'verify',
    'verifyDummy',
  ],
});
