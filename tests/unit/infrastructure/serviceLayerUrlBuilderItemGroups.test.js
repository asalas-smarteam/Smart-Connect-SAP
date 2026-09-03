import { buildServiceLayerUrl } from '../../../src/infrastructure/sap/serviceLayerUrlBuilder.js';

function getFilter(url) {
  return decodeURIComponent(url.split('$filter=')[1].split('&')[0]);
}

describe("buildServiceLayerUrl — operador 'in' en B1", () => {
  const productConfig = {
    serviceLayerBaseUrl: 'https://sap.example.com',
    serviceLayerPath: '/Items',
    objectType: 'product',
    integrationModeName: 'SERVICE_LAYER',
  };

  const productMappings = [
    { sourceField: 'ItemCode', sourceContext: 'product' },
    { sourceField: 'ItemName', sourceContext: 'product' },
  ];

  // El caso del cliente: OITB.ItmsGrpCod IN (101,102,105,106,107,108) sobre /Items.
  it('renderiza los grupos de articulos como un grupo OR con literales numericos', () => {
    const url = buildServiceLayerUrl(
      {
        ...productConfig,
        filters: [
          { property: 'ItemsGroupCode', operator: 'in', value: [101, 102, 105, 106, 107, 108] },
        ],
      },
      productMappings
    );

    expect(getFilter(url)).toBe(
      '(ItemsGroupCode eq 101 or ItemsGroupCode eq 102 or ItemsGroupCode eq 105'
      + ' or ItemsGroupCode eq 106 or ItemsGroupCode eq 107 or ItemsGroupCode eq 108)'
    );
  });

  // Sin parentesis, el `and` se aplicaria solo al ultimo miembro del OR y entrarian
  // items de cualquier grupo con tal de estar activos.
  it('mantiene el OR agrupado cuando se combina con otros filtros', () => {
    const url = buildServiceLayerUrl(
      {
        ...productConfig,
        filters: [
          { property: 'ItemsGroupCode', operator: 'in', value: [101, 102] },
          { property: 'Valid', operator: 'eq', value: 'tYES' },
        ],
      },
      productMappings
    );

    expect(getFilter(url)).toBe(
      "(ItemsGroupCode eq 101 or ItemsGroupCode eq 102) and Valid eq 'tYES'"
    );
  });

  it('entrecomilla los valores string y escapa la comilla simple', () => {
    const url = buildServiceLayerUrl(
      {
        ...productConfig,
        filters: [{ property: 'ItemClass', operator: 'in', value: ['ZC01', "O'Brien"] }],
      },
      productMappings
    );

    expect(getFilter(url)).toBe("(ItemClass eq 'ZC01' or ItemClass eq 'O''Brien')");
  });

  it('colapsa un solo valor y acepta un value escalar', () => {
    const arreglo = buildServiceLayerUrl(
      { ...productConfig, filters: [{ property: 'ItemsGroupCode', operator: 'in', value: [101] }] },
      productMappings
    );
    expect(getFilter(arreglo)).toBe('ItemsGroupCode eq 101');

    const escalar = buildServiceLayerUrl(
      { ...productConfig, filters: [{ property: 'ItemsGroupCode', operator: 'in', value: 101 }] },
      productMappings
    );
    expect(getFilter(escalar)).toBe('ItemsGroupCode eq 101');
  });

  // cleanValue() descarta `0` y `false` por su `value || ''`, asi que filtrar los
  // vacios con esa helper borraria en silencio miembros validos del OR.
  it('conserva el 0 y el false como miembros del OR', () => {
    const url = buildServiceLayerUrl(
      {
        ...productConfig,
        filters: [{ property: 'ItemsGroupCode', operator: 'in', value: [0, 101] }],
      },
      productMappings
    );

    expect(getFilter(url)).toBe('(ItemsGroupCode eq 0 or ItemsGroupCode eq 101)');
  });

  it('descarta nulls y strings vacios, y lanza si no queda ningun miembro', () => {
    const url = buildServiceLayerUrl(
      {
        ...productConfig,
        filters: [{ property: 'ItemsGroupCode', operator: 'in', value: [101, null, '  ', 102] }],
      },
      productMappings
    );
    expect(getFilter(url)).toBe('(ItemsGroupCode eq 101 or ItemsGroupCode eq 102)');

    expect(() => buildServiceLayerUrl(
      { ...productConfig, filters: [{ property: 'ItemsGroupCode', operator: 'in', value: [] }] },
      productMappings
    )).toThrow("requires at least one value for 'in'");
  });
});
