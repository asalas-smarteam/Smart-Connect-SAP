import { createPort } from '../port-validator.js';

export const SapDataSourcePort = createPort({
  name: 'SapDataSourcePort',
  methods: [
    'fetchData',
  ],
});
