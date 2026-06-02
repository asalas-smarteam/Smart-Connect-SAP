import { createPort } from '../port-validator.js';

export const SyncLogRepositoryPort = createPort({
  name: 'SyncLogRepositoryPort',
  methods: [
    'start',
    'finish',
  ],
});
