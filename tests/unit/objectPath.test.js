import { hasByPath, pickByPath } from '#shared/utils/object-path.utils.js';

describe('object-path.utils hasByPath', () => {
  // El motivo de existir de hasByPath: pickByPath normaliza undefined a null en su return, asi
  // que "la clave no vino" y "la clave vino en null" le salen identicas. El PATCH de lineas de
  // cotizacion necesita distinguirlas, porque la primera significa "no toques el campo en SAP" y
  // la segunda "borralo".
  it('distingue la clave ausente de la clave presente en null, que pickByPath colapsa', () => {
    const presente = { item_description: null };
    const ausente = {};

    expect(pickByPath(presente, 'item_description')).toBeNull();
    expect(pickByPath(ausente, 'item_description')).toBeNull();

    expect(hasByPath(presente, 'item_description')).toBe(true);
    expect(hasByPath(ausente, 'item_description')).toBe(false);
  });

  it('reconoce la clave presente con cualquier valor vacio', () => {
    expect(hasByPath({ campo: '' }, 'campo')).toBe(true);
    expect(hasByPath({ campo: '   ' }, 'campo')).toBe(true);
    expect(hasByPath({ campo: 'null' }, 'campo')).toBe(true);
    expect(hasByPath({ campo: 0 }, 'campo')).toBe(true);
    expect(hasByPath({ campo: false }, 'campo')).toBe(true);
  });

  it('recorre paths anidados', () => {
    expect(hasByPath({ deal: { comments: null } }, 'deal.comments')).toBe(true);
    expect(hasByPath({ deal: {} }, 'deal.comments')).toBe(false);
    expect(hasByPath({ deal: null }, 'deal.comments')).toBe(false);
    expect(hasByPath({}, 'deal.comments')).toBe(false);
  });

  // Mismo salto al primer elemento que hace pickByPath, para que las dos respondan sobre el
  // mismo valor.
  it('salta al primer elemento cuando encuentra un array, igual que pickByPath', () => {
    const source = { contactos: [{ email: null }] };

    expect(pickByPath(source, 'contactos.email')).toBeNull();
    expect(hasByPath(source, 'contactos.email')).toBe(true);
    expect(hasByPath({ contactos: [{}] }, 'contactos.email')).toBe(false);
    expect(hasByPath({ contactos: [] }, 'contactos.email')).toBe(false);
  });

  it('devuelve false para un primitivo en vez de reventar', () => {
    expect(hasByPath({ campo: 'texto' }, 'campo.largo')).toBe(false);
    expect(hasByPath('texto', 'largo')).toBe(false);
    expect(hasByPath(42, 'toFixed')).toBe(false);
  });

  it('devuelve false para un path vacio o nulo', () => {
    expect(hasByPath({ campo: 1 }, '')).toBe(false);
    expect(hasByPath({ campo: 1 }, null)).toBe(false);
    expect(hasByPath({ campo: 1 }, '   ')).toBe(false);
  });

  // `in` sube por la cadena de prototipos: con `in`, un mapeo cuyo targetField fuera `toString`
  // o `constructor` daria "presente" sobre CUALQUIER objeto y el llamador limpiaria un campo de
  // SAP creyendo que el payload lo trae vacio. Por eso la implementacion usa hasOwnProperty.
  it('no toma una clave heredada del prototipo como presente en el payload', () => {
    expect(hasByPath({}, 'toString')).toBe(false);
    expect(hasByPath({}, 'constructor')).toBe(false);
    expect(hasByPath({ toString: null }, 'toString')).toBe(true);
  });
});
