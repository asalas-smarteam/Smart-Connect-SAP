function normalizeComparableValue(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function resolveSapIdentifier(properties = {}) {
  return normalizeComparableValue(
    properties?.idsap ?? properties?.idSap ?? properties?.internalcode
  );
}

function hasDifferentValue(currentValue, nextValue) {
  return normalizeComparableValue(currentValue) !== normalizeComparableValue(nextValue);
}

export function shouldUpdateByKeyFields({
  existingProperties = {},
  incomingProperties = {},
  nameField,
}) {
  return (
    hasDifferentValue(existingProperties?.[nameField], incomingProperties?.[nameField])
    || hasDifferentValue(existingProperties?.phone, incomingProperties?.phone)
    || hasDifferentValue(
      resolveSapIdentifier(existingProperties),
      resolveSapIdentifier(incomingProperties)
    )
  );
}

export function buildIdentifierOnlyPayload(properties = {}) {
  const nextProperties = {};
  const idsap = normalizeComparableValue(properties?.idsap ?? properties?.idSap);
  const internalcode = normalizeComparableValue(properties?.internalcode);

  if (idsap) {
    nextProperties.idsap = idsap;
  }

  if (internalcode) {
    nextProperties.internalcode = internalcode;
  }

  return Object.keys(nextProperties).length > 0
    ? { properties: nextProperties }
    : null;
}

export default {
  shouldUpdateByKeyFields,
  buildIdentifierOnlyPayload,
};
