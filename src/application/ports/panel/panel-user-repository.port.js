import { createPort } from '../port-validator.js';

export const PanelUserRepositoryPort = createPort({
  name: 'PanelUserRepositoryPort',
  methods: [
    'findByEmail',
    'findById',
    'create',
    'update',
    'incrementTokenVersion',
    'list',
    'touchLastLogin',
  ],
});
