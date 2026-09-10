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

// Compañera de pickByPath para cuando "la clave no vino" y "la clave vino vacía" tienen que
// decidir cosas distintas. pickByPath NO sirve para eso: normaliza undefined a null en su return
// (línea de arriba), así que colapsa los dos casos en uno.
//
// Recorre el mismo camino que pickByPath, incluido el salto al primer elemento cuando encuentra
// un array, y responde únicamente si el último segmento existe como propiedad del contenedor.
export function hasByPath(input, path) {
  if (!path) {
    return false;
  }

  const segments = String(path)
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (!segments.length) {
    return false;
  }

  let current = input;

  for (const segment of segments.slice(0, -1)) {
    if (current === null || typeof current === 'undefined') {
      return false;
    }

    if (Array.isArray(current)) {
      current = current[0];
      if (current === null || typeof current === 'undefined') {
        return false;
      }
    }

    current = current?.[segment];
  }

  if (current === null || typeof current === 'undefined') {
    return false;
  }

  if (Array.isArray(current)) {
    current = current[0];
    if (current === null || typeof current === 'undefined') {
      return false;
    }
  }

  // hasOwnProperty y no `in`: `in` sube por la cadena de prototipos, así que un mapeo cuyo
  // targetField sea `toString` o `constructor` daría "presente" sobre cualquier objeto y haría
  // que el llamador creyera que el payload trae ese campo.
  //
  // El typeof previo es necesario porque un primitivo no tiene propiedades propias que buscar.
  return typeof current === 'object'
    && Object.prototype.hasOwnProperty.call(current, segments[segments.length - 1]);
}

