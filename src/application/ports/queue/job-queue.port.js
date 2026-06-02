import { createPort } from '../port-validator.js';

export const JobQueuePort = createPort({
  name: 'JobQueuePort',
  methods: [
    'addManualSapSyncJob',
    'addScheduledSapSyncJob',
    'addWebhookTenantJob',
  ],
});
