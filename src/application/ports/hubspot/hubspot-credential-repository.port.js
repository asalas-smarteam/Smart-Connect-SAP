import { createPort } from '../port-validator.js';

export const HubspotCredentialRepositoryPort = createPort({
  name: 'HubspotCredentialRepositoryPort',
  methods: [
    'findByClientConfig',
    'findById',
  ],
});
