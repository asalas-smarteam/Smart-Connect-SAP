import { createPort } from '../port-validator.js';

export const SessionTokenPort = createPort({
  name: 'SessionTokenPort',
  methods: [
    'sign',
    'verify',
  ],
});
