import { createPort } from '../port-validator.js';

export const TemporaryPasswordGeneratorPort = createPort({
  name: 'TemporaryPasswordGeneratorPort',
  methods: [
    'generate',
  ],
});
