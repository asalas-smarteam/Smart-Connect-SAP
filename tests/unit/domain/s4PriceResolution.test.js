import {
  resolveS4PriceForMaterial,
  S4_PRICE_SOURCES,
} from '../../../src/domain/prices/s4-price-resolution.service.js';

// Candidatos con la forma que produce S4PriceListClient. Valores reales del S/4 de
// Multiquímica (material 80000017, área FQCR/01, verificados el 2026-08-18).
function candidate(overrides = {}) {
  return {
    conditionRecord: '0000418608',
    conditionTable: '502',
    priceListType: 'ZC',
    conditionRateValue: 1.28,
    conditionCurrency: 'USD',
    conditionQuantity: 1,
    conditionQuantityUnit: 'KG',
    conditionIsDeleted: false,
    ...overrides,
  };
}

describe('resolveS4PriceForMaterial', () => {
  it('elige la tabla 502 de la lista del cliente', () => {
    const result = resolveS4PriceForMaterial({
      candidates: [
        candidate({ conditionRecord: '0000418606', priceListType: 'ZA', conditionRateValue: 2.08 }),
        candidate(),
      ],
      customerPriceListType: 'ZC',
      defaultPriceListType: 'ZA',
    });

    expect(result).toEqual({
      price: 1.28,
      currency: 'USD',
      priceListType: 'ZC',
      conditionRecord: '0000418608',
      // La unidad de la condición viaja en el resultado (no se convierte): es lo único que
      // permite reconstruir después de dónde salió un precio unitario raro.
      conditionQuantityUnit: 'KG',
      source: S4_PRICE_SOURCES.CUSTOMER_PRICE_LIST,
    });
  });

  it('cae a la lista default cuando la del cliente no tiene registro', () => {
    const result = resolveS4PriceForMaterial({
      candidates: [candidate({ priceListType: 'ZA', conditionRateValue: 2.08 })],
      customerPriceListType: 'ZD',
      defaultPriceListType: 'ZA',
    });

    expect(result.source).toBe(S4_PRICE_SOURCES.DEFAULT_PRICE_LIST);
    expect(result.price).toBe(2.08);
    expect(result.priceListType).toBe('ZA');
  });

  it('cae al default del producto (tablas 501/504, sin lista) cuando ninguna lista tiene registro', () => {
    const result = resolveS4PriceForMaterial({
      candidates: [
        candidate({ conditionRecord: '0000418745', conditionTable: '504', priceListType: '', conditionRateValue: 1.25 }),
      ],
      customerPriceListType: 'ZD',
      defaultPriceListType: 'ZA',
    });

    expect(result.source).toBe(S4_PRICE_SOURCES.PRODUCT_DEFAULT);
    expect(result.price).toBe(1.25);
    expect(result.priceListType).toBeNull();
  });

  it('divide por ConditionQuantity cuando la tarifa no es por unidad', () => {
    const result = resolveS4PriceForMaterial({
      candidates: [
        candidate({ conditionTable: '501', priceListType: '', conditionRateValue: 2700, conditionQuantity: 1000 }),
      ],
      customerPriceListType: null,
      defaultPriceListType: null,
    });

    expect(result.price).toBe(2.7);
  });

  it('trata ConditionQuantity ausente, cero o negativa como 1 (no divide por cero)', () => {
    // Cantidad ausente: undefined
    const resultUndefined = resolveS4PriceForMaterial({
      candidates: [
        candidate({ conditionTable: '501', priceListType: '', conditionRateValue: 100 }),
      ],
      customerPriceListType: null,
      defaultPriceListType: null,
    });
    expect(resultUndefined.price).toBe(100);

    // Cantidad cero
    const resultZero = resolveS4PriceForMaterial({
      candidates: [
        candidate({ conditionTable: '501', priceListType: '', conditionRateValue: 100, conditionQuantity: 0 }),
      ],
      customerPriceListType: null,
      defaultPriceListType: null,
    });
    expect(resultZero.price).toBe(100);

    // Cantidad negativa
    const resultNegative = resolveS4PriceForMaterial({
      candidates: [
        candidate({ conditionTable: '501', priceListType: '', conditionRateValue: 100, conditionQuantity: -50 }),
      ],
      customerPriceListType: null,
      defaultPriceListType: null,
    });
    expect(resultNegative.price).toBe(100);
  });

  it('descarta registros borrados aunque estén vigentes por fechas', () => {
    const result = resolveS4PriceForMaterial({
      candidates: [
        candidate({ conditionRecord: '0000177449', conditionTable: '501', priceListType: '', conditionRateValue: 2.1, conditionIsDeleted: true }),
      ],
      customerPriceListType: 'ZD',
      defaultPriceListType: 'ZD',
    });

    expect(result).toBeNull();
  });

  it('descarta tarifas no positivas y devuelve null sin candidatos', () => {
    expect(resolveS4PriceForMaterial({
      candidates: [candidate({ conditionRateValue: 0 })],
      customerPriceListType: 'ZC',
    })).toBeNull();

    expect(resolveS4PriceForMaterial({ candidates: [] })).toBeNull();
    expect(resolveS4PriceForMaterial()).toBeNull();
  });

  // Hueco que la revisión final marcó como I1: con default de producto en la 501 Y en la 504,
  // `find` sobre el arreglo dejaba ganar al orden de respuesta de Gateway y el precio escrito no
  // era reproducible. La prioridad es el orden de PRODUCT_DEFAULT_CONDITION_TABLES: gana la 501.
  it('con default de producto en la 501 y en la 504 a la vez, gana la 501 sin importar el orden de la respuesta', () => {
    const c501 = candidate({
      conditionRecord: '0000177449', conditionTable: '501', priceListType: '', conditionRateValue: 2.1,
    });
    const c504 = candidate({
      conditionRecord: '0000418745', conditionTable: '504', priceListType: '', conditionRateValue: 1.25,
    });

    const with504First = resolveS4PriceForMaterial({
      candidates: [c504, c501],
      customerPriceListType: 'ZD',
      defaultPriceListType: 'ZA',
    });
    const with501First = resolveS4PriceForMaterial({
      candidates: [c501, c504],
      customerPriceListType: 'ZD',
      defaultPriceListType: 'ZA',
    });

    expect(with504First.conditionRecord).toBe('0000177449');
    expect(with504First.price).toBe(2.1);
    // Mismo resultado con el arreglo al revés: el orden de la respuesta no decide nada.
    expect(with501First).toEqual(with504First);
  });

  it('usa la 504 cuando la 501 no tiene candidato usable', () => {
    const result = resolveS4PriceForMaterial({
      candidates: [
        candidate({
          conditionRecord: '0000177449', conditionTable: '501', priceListType: '', conditionRateValue: 2.1, conditionIsDeleted: true,
        }),
        candidate({
          conditionRecord: '0000418745', conditionTable: '504', priceListType: '', conditionRateValue: 1.25,
        }),
      ],
      customerPriceListType: 'ZD',
      defaultPriceListType: 'ZA',
    });

    expect(result.conditionRecord).toBe('0000418745');
    expect(result.source).toBe(S4_PRICE_SOURCES.PRODUCT_DEFAULT);
  });

  it('ignora un candidato de la tabla 502 cuyo PriceListType no es el pedido', () => {
    expect(resolveS4PriceForMaterial({
      candidates: [candidate({ priceListType: 'ZB' })],
      customerPriceListType: 'ZC',
      defaultPriceListType: 'ZD',
    })).toBeNull();
  });
});
