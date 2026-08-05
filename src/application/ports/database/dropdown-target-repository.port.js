import { createPort } from '../port-validator.js';

// Resolves which HubSpot properties a SAP field feeds. A single SAP field can
// be mapped on several object types at once (PayTermsGrpCode on both company
// and contact), so this returns a list, not one target.
export const DropdownTargetRepositoryPort = createPort({
  name: 'DropdownTargetRepositoryPort',
  methods: [
    // findTargetsBySourceFields({ tenantContext, hubspotCredentialId, sourceFields })
    // -> [{ sourceField, objectType, targetField }]
    'findTargetsBySourceFields',
  ],
});

export default DropdownTargetRepositoryPort;
