import { createPort } from '../port-validator.js';

export const ClientConfigRepositoryPort = createPort({
  name: 'ClientConfigRepositoryPort',
  methods: [
    'findById',
    'markSyncSucceeded',
    'markSyncFailed',
  ],
});
