const ITEM_OBJECT_TYPE = 'dgboItems';
const ITEM_GROUP_OBJECT_TYPE = 'dgboItemGroups';

function toNonEmptyString(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function toTimestamp(value) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isGroupValidForDate(discountGroup, currentTimestamp) {
  const validFrom = toTimestamp(discountGroup?.ValidFrom);
  const validTo = toTimestamp(discountGroup?.ValidTo);

  if (validFrom === null || validTo === null) {
    return false;
  }

  return currentTimestamp >= validFrom && currentTimestamp <= validTo;
}

function findLineDiscount(validGroups, objectType, objectCode) {
  if (!objectCode) {
    return null;
  }

  for (const discountGroup of validGroups) {
    const lines = Array.isArray(discountGroup?.DiscountGroupLineCollection)
      ? discountGroup.DiscountGroupLineCollection
      : [];

    const matchedLine = lines.find(
      (line) => line?.ObjectType === objectType && toNonEmptyString(line?.ObjectCode) === objectCode
    );

    if (matchedLine) {
      return matchedLine.Discount;
    }
  }

  return null;
}

export function resolveDiscount(discountGroups, { itemCode, itemsGroupCode, currentDate = new Date() }) {
  const normalizedItemCode = toNonEmptyString(itemCode);
  const normalizedItemsGroupCode = toNonEmptyString(itemsGroupCode);

  if (!Array.isArray(discountGroups) || discountGroups.length === 0) {
    return null;
  }

  const currentTimestamp = toTimestamp(currentDate);
  if (currentTimestamp === null) {
    return null;
  }

  const validGroups = discountGroups.filter((discountGroup) => (
    isGroupValidForDate(discountGroup, currentTimestamp)
  ));

  if (validGroups.length === 0) {
    return null;
  }

  const itemDiscount = findLineDiscount(validGroups, ITEM_OBJECT_TYPE, normalizedItemCode);
  if (itemDiscount !== null) {
    return itemDiscount;
  }

  return findLineDiscount(validGroups, ITEM_GROUP_OBJECT_TYPE, normalizedItemsGroupCode);
}

export default resolveDiscount;
