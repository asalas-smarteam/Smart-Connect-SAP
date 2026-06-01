import { normalizeNumber, toNonEmptyString } from '#shared/utils/string.utils.js';

function roundCurrency(value) {
  return Math.round((normalizeNumber(value, 0) + Number.EPSILON) * 100) / 100;
}

function normalizeOptionalNumber(value) {
  const rawValue = String(value ?? '').trim();
  if (!rawValue) {
    return null;
  }

  const normalized = Number(rawValue);
  return Number.isFinite(normalized) ? normalized : null;
}

function isFixedCalculation(type) {
  return ['fixed', 'fijo', 'valor_fijo', 'monto_fijo'].includes(
    String(type || '').trim().toLowerCase()
  );
}

export function calculateUnitPriceWithMisc({
  sapPrice,
  lineItem,
  config,
}) {
  const originalPrice = roundCurrency(sapPrice);

  if (config?.enableMiscPriceCalculation !== true) {
    return {
      price: originalPrice,
      originalPrice: null,
      originalPriceTargetProperty: null,
      warning: null,
    };
  }

  const originalPriceTargetProperty = toNonEmptyString(config.originalPriceTargetProperty);
  const miscSourceProperty = toNonEmptyString(config.miscSourceProperty);

  if (!originalPriceTargetProperty || !miscSourceProperty) {
    return {
      price: originalPrice,
      originalPrice,
      originalPriceTargetProperty,
      warning: 'Misc price calculation config is incomplete',
    };
  }

  const miscValue = normalizeOptionalNumber(lineItem?.[miscSourceProperty]);

  if (miscValue === null) {
    return {
      price: originalPrice,
      originalPrice,
      originalPriceTargetProperty,
      warning: `Misc price value is not numeric for property ${miscSourceProperty}`,
    };
  }

  const price = isFixedCalculation(config.miscCalculationType)
    ? originalPrice + miscValue
    : originalPrice + ((originalPrice * miscValue) / 100);

  return {
    price: roundCurrency(price),
    originalPrice,
    originalPriceTargetProperty,
    warning: null,
  };
}
