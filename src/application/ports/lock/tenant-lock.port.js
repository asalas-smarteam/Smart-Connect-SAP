import { createPort } from '../port-validator.js';

export const TenantLockPort = createPort({
  name: 'TenantLockPort',
  methods: [
    'acquire',
    'extend',
    'release',
  ],
});
