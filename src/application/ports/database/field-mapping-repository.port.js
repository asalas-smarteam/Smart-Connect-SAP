import { createPort } from '../port-validator.js';

export const FieldMappingRepositoryPort = createPort({
  name: 'FieldMappingRepositoryPort',
  methods: [
    'mapRecords',
    'ensureDefaultMappings',
    'findMappings',
  ],
});
