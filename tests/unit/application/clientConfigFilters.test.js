import {
  sanitizeIncomingCustomFilters,
  buildMergedFilters,
} from '../../../src/application/services/clientConfigFilters.service.js';

describe("sanitizeIncomingCustomFilters — operador 'in'", () => {
  it('acepta un in con arreglo y conserva los valores numericos', () => {
    const [filtro] = sanitizeIncomingCustomFilters([
      { property: 'ItemsGroupCode', operator: 'in', value: [101, 102, 105, 106, 107, 108] },
    ]);

    expect(filtro).toEqual({
      operator: 'in',
      property: 'ItemsGroupCode',
      value: [101, 102, 105, 106, 107, 108],
      isDefault: false,
      isDynamic: false,
      dynamicType: 'datetime',
      editable: true,
    });
  });

  // Guardar un 'in' mal formado deja la ClientConfig en un estado que solo falla al
  // armar la URL, ya corriendo la tarea. El error tiene que salir en el request.
  it('rechaza un in sin arreglo o con arreglo vacio', () => {
    expect(() => sanitizeIncomingCustomFilters([
      { property: 'ItemsGroupCode', operator: 'in', value: 101 },
    ])).toThrow("filters[0].value must be a non-empty array when operator is 'in'");

    expect(() => sanitizeIncomingCustomFilters([
      { property: 'ItemsGroupCode', operator: 'in', value: [] },
    ])).toThrow("filters[0].value must be a non-empty array when operator is 'in'");
  });

  it('sigue rechazando operadores fuera del enum del dominio', () => {
    expect(() => sanitizeIncomingCustomFilters([
      { property: 'ItemsGroupCode', operator: 'like', value: '101' },
    ])).toThrow('filters[0].operator must be one of');
  });

  it('sigue bloqueando los campos controlados', () => {
    expect(() => sanitizeIncomingCustomFilters([
      { property: 'ItemsGroupCode', operator: 'in', value: [101], isDefault: true },
    ])).toThrow('filters[0].isDefault is not allowed');
  });
});

describe("buildMergedFilters con un 'in' custom", () => {
  it('conserva el arreglo al mezclar con los defaults', () => {
    const merged = buildMergedFilters({
      defaultFilters: [
        { property: 'UpdateDate', operator: 'ge', value: null, isDynamic: true, dynamicType: 'date' },
      ],
      customFilters: sanitizeIncomingCustomFilters([
        { property: 'ItemsGroupCode', operator: 'in', value: [101, 102] },
      ]),
    });

    expect(merged.defaultCount).toBe(1);
    expect(merged.customCount).toBe(1);
    expect(merged.filters[1].value).toEqual([101, 102]);
    expect(merged.filters[0].editable).toBe(false);
  });

  it('deduplica dos in identicos por su clave normalizada', () => {
    const custom = sanitizeIncomingCustomFilters([
      { property: 'ItemsGroupCode', operator: 'in', value: [101, 102] },
      { property: 'ItemsGroupCode', operator: 'in', value: [101, 102] },
    ]);

    expect(buildMergedFilters({ defaultFilters: [], customFilters: custom }).customCount).toBe(1);
  });
});
