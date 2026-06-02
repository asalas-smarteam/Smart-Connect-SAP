import { createPort } from '../port-validator.js';

export const HubspotSyncTargetPort = createPort({
  name: 'HubspotSyncTargetPort',
  methods: [
    'send',
  ],
});
