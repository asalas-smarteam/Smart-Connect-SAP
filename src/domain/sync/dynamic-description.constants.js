export const DYNAMIC_DESCRIPTION_CONFIG_KEY = 'requireDinamicDescription';

// Applied when a rule omits them. Matches the original request: compose the
// HubSpot product `name` out of several SAP product fields.
export const DEFAULT_DYNAMIC_DESCRIPTION_RULE = Object.freeze({
  objectType: 'product',
  sourceContext: 'product',
  targetField: 'name',
});

export const DEFAULT_DYNAMIC_DESCRIPTION_CONFIG = Object.freeze({
  isRequired: false,
  regex: '',
});

export default {
  DYNAMIC_DESCRIPTION_CONFIG_KEY,
  DEFAULT_DYNAMIC_DESCRIPTION_RULE,
  DEFAULT_DYNAMIC_DESCRIPTION_CONFIG,
};
