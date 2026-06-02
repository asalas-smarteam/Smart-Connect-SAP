import { createPort } from '../port-validator.js';

export const LoggerPort = createPort({
  name: 'LoggerPort',
  methods: [
    'info',
    'warn',
    'error',
    'debug',
  ],
});
