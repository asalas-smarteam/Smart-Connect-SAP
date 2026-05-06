import { validateProvisioningPayload } from '../../utils/provisioningValidation.js';

export class ProvisioningPayloadValidatorAdapter {
  validate(payload) {
    return validateProvisioningPayload(payload);
  }
}

export default ProvisioningPayloadValidatorAdapter;
