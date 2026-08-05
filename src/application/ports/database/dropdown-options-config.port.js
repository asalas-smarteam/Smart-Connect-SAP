import { createPort } from '../port-validator.js';

export const DropdownOptionsConfigPort = createPort({
  name: 'DropdownOptionsConfigPort',
  methods: [
    // getDropdownOptionsConfig({ tenantContext }) -> { enabled, sources, invalidSources }
    'getDropdownOptionsConfig',
  ],
});

export default DropdownOptionsConfigPort;
