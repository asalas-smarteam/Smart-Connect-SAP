import { createPort } from '../port-validator.js';

export const SyncWarningRepositoryPort = createPort({
  name: 'SyncWarningRepositoryPort',
  methods: [
    'record',
  ],
});
