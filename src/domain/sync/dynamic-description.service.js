import {
  DEFAULT_DYNAMIC_DESCRIPTION_RULE,
} from './dynamic-description.constants.js';

// Placeholders reference SAP *sourceField* names (the same ones stored in
// FieldMappings.sourceField), never the HubSpot target property. Dotted paths
// are supported so S/4 expansions like `to_Description.ProductDescription`
// work the same way they do in a plain 1:1 mapping.
const PLACEHOLDER_PATTERN = /\$\{\s*([^${}]+?)\s*\}/g;

// Trimmed off both ends after rendering so a dropped placeholder never leaves a
// dangling " - " at the start or the end of the composed value.
const EDGE_SEPARATORS = /^[\s\-–—_,;:|/\\]+|[\s\-–—_,;:|/\\]+$/g;

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseJsonString(value) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function toDisplayValue(value) {
  if (value === null || typeof value === 'undefined') {
    return '';
  }

  if (typeof value === 'string') {
    return value.trim();
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }

  if (typeof value === 'boolean') {
    return String(value);
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  }

  return '';
}

export function tokenizeTemplate(template) {
  const source = cleanString(template);

  if (!source) {
    return [];
  }

  const tokens = [];
  const pattern = new RegExp(PLACEHOLDER_PATTERN.source, 'g');
  let lastIndex = 0;
  let match = pattern.exec(source);

  while (match) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'literal', text: source.slice(lastIndex, match.index) });
    }

    const field = cleanString(match[1]);
    if (field) {
      tokens.push({ type: 'field', field });
    }

    lastIndex = match.index + match[0].length;
    match = pattern.exec(source);
  }

  if (lastIndex < source.length) {
    tokens.push({ type: 'literal', text: source.slice(lastIndex) });
  }

  return tokens;
}

function normalizeRule(rawRule) {
  if (!rawRule || typeof rawRule !== 'object' || Array.isArray(rawRule)) {
    return null;
  }

  // `regex` is the field name the configuration document uses; `template` is
  // accepted as an alias because that is what the value actually is.
  const template = cleanString(rawRule.regex) || cleanString(rawRule.template);

  if (!template) {
    return null;
  }

  const sourceFields = tokenizeTemplate(template)
    .filter((token) => token.type === 'field')
    .map((token) => token.field);

  if (sourceFields.length === 0) {
    return null;
  }

  return {
    objectType: cleanString(rawRule.objectType) || DEFAULT_DYNAMIC_DESCRIPTION_RULE.objectType,
    // '*' means "any context of this objectType".
    sourceContext: cleanString(rawRule.sourceContext) || DEFAULT_DYNAMIC_DESCRIPTION_RULE.sourceContext,
    targetField: cleanString(rawRule.targetField) || DEFAULT_DYNAMIC_DESCRIPTION_RULE.targetField,
    template,
    sourceFields: [...new Set(sourceFields)],
  };
}

/**
 * Accepts every shape the Configurations document may realistically hold:
 *
 *   { isRequired: true, regex: '${ItemName} - ${U_ACO_IdAdicional}' }
 *   { isRequired: true, rules: [{ objectType, sourceContext, targetField, regex }] }
 *   [{ targetField: 'name', regex: '...' }]
 *   '<any of the above as a JSON string>'
 */
export function normalizeDynamicDescriptionConfig(value) {
  const disabled = { isRequired: false, rules: [] };

  if (!value) {
    return disabled;
  }

  if (typeof value === 'string') {
    const parsed = parseJsonString(value);
    return parsed ? normalizeDynamicDescriptionConfig(parsed) : disabled;
  }

  if (Array.isArray(value)) {
    const rules = value.map(normalizeRule).filter(Boolean);
    return { isRequired: rules.length > 0, rules };
  }

  if (typeof value !== 'object') {
    return disabled;
  }

  const rawRules = Array.isArray(value.rules) ? value.rules : [];
  const rules = [...rawRules, value].map(normalizeRule).filter(Boolean);

  if (rules.length === 0) {
    return disabled;
  }

  // Absent `isRequired` means "on": a document carrying a template but no flag
  // was clearly written to be used. Only an explicit `false` turns it off.
  return { isRequired: value.isRequired !== false, rules };
}

function ruleMatches(rule, objectType, sourceContext) {
  const targetObjectType = cleanString(objectType).toLowerCase();
  const ruleObjectType = rule.objectType.toLowerCase();

  if (ruleObjectType !== '*' && targetObjectType && ruleObjectType !== targetObjectType) {
    return false;
  }

  const targetContext = cleanString(sourceContext).toLowerCase();
  const ruleContext = rule.sourceContext.toLowerCase();

  if (ruleContext === '*' || !targetContext) {
    return true;
  }

  return ruleContext === targetContext;
}

/**
 * Renders one template. Placeholders that resolve to an empty value are dropped
 * along with the separator that preceded them, so `${A} - ${B}` yields `A` when
 * B is missing instead of `A - `.
 *
 * Returns null when nothing resolved, which callers use to leave the existing
 * 1:1 mapped value untouched.
 */
export function renderTemplate(template, resolveField) {
  const tokens = tokenizeTemplate(template);

  if (tokens.length === 0) {
    return null;
  }

  let rendered = '';
  let pendingLiteral = '';
  let lastFieldWasEmpty = false;

  for (const token of tokens) {
    if (token.type === 'literal') {
      pendingLiteral += token.text;
      continue;
    }

    const value = toDisplayValue(resolveField(token.field));

    if (!value) {
      pendingLiteral = '';
      lastFieldWasEmpty = true;
      continue;
    }

    rendered += `${pendingLiteral}${value}`;
    pendingLiteral = '';
    lastFieldWasEmpty = false;
  }

  // A trailing literal after a dropped placeholder is that placeholder's
  // decoration, so it goes with it.
  if (!lastFieldWasEmpty) {
    rendered += pendingLiteral;
  }

  const composed = rendered.replace(EDGE_SEPARATORS, '');

  return composed || null;
}

/**
 * Overwrites the mapped properties with the composed values defined by the
 * tenant configuration. Mutates and returns `properties`.
 *
 * `resolveField(record, sourceField)` is supplied by the caller so each call
 * site keeps using its own path resolver.
 */
export function applyDynamicDescription({
  properties,
  record,
  objectType,
  sourceContext,
  config,
  resolveField,
}) {
  const targetProperties = properties ?? {};
  const normalized = normalizeDynamicDescriptionConfig(config);

  if (!normalized.isRequired || normalized.rules.length === 0) {
    return targetProperties;
  }

  if (typeof resolveField !== 'function') {
    return targetProperties;
  }

  normalized.rules
    .filter((rule) => ruleMatches(rule, objectType, sourceContext))
    .forEach((rule) => {
      const composed = renderTemplate(rule.template, (field) => resolveField(record, field));

      if (composed !== null) {
        targetProperties[rule.targetField] = composed;
      }
    });

  return targetProperties;
}

/**
 * SAP field names every matching rule needs. Used to widen the OData `$select`
 * so a template can reference a field that has no FieldMapping row of its own.
 */
export function getDynamicDescriptionSourceFields(config, { objectType, sourceContext } = {}) {
  const normalized = normalizeDynamicDescriptionConfig(config);

  if (!normalized.isRequired) {
    return [];
  }

  const fields = normalized.rules
    .filter((rule) => ruleMatches(rule, objectType, sourceContext))
    .flatMap((rule) => rule.sourceFields);

  return [...new Set(fields)];
}

/**
 * Returns `mappings` widened with a read-only entry per template source field
 * that has no mapping row of its own, so the OData `$select`/`$expand` built
 * from these mappings actually brings the field back from SAP.
 *
 * The synthetic entries carry no `targetField` and are only ever used to build
 * the SAP request — never to write HubSpot properties.
 */
export function withDynamicDescriptionSelectFields(mappings, config, { objectType, sourceContext } = {}) {
  const baseMappings = Array.isArray(mappings) ? mappings : [];
  const requiredFields = getDynamicDescriptionSourceFields(config, { objectType, sourceContext });

  if (requiredFields.length === 0) {
    return baseMappings;
  }

  const alreadySelected = new Set(
    baseMappings
      .filter((mapping) => mapping?.includeInServiceLayerSelect !== false)
      .map((mapping) => cleanString(mapping?.sourceField))
      .filter(Boolean)
  );

  const missing = requiredFields
    .filter((field) => !alreadySelected.has(field))
    .map((field) => ({
      sourceField: field,
      targetField: null,
      objectType: objectType ?? null,
      sourceContext: sourceContext ?? null,
      includeInServiceLayerSelect: true,
      isActive: true,
    }));

  return missing.length > 0 ? [...baseMappings, ...missing] : baseMappings;
}

export default {
  applyDynamicDescription,
  withDynamicDescriptionSelectFields,
  getDynamicDescriptionSourceFields,
  normalizeDynamicDescriptionConfig,
  renderTemplate,
  tokenizeTemplate,
};
