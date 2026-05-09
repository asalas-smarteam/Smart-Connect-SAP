export function pickByPath(input, path) {
  if (!path) {
    return null;
  }

  const segments = String(path)
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (!segments.length) {
    return null;
  }

  let current = input;

  for (const segment of segments) {
    if (current === null || typeof current === 'undefined') {
      return null;
    }

    if (Array.isArray(current)) {
      current = current[0];
      if (current === null || typeof current === 'undefined') {
        return null;
      }
    }

    current = current?.[segment];
  }

  return typeof current === 'undefined' ? null : current;
}

