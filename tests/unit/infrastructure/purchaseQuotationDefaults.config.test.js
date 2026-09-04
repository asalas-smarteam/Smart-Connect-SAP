import {
  DEFAULT_PURCHASE_QUOTATION_DEFAULTS,
  PURCHASE_QUOTATION_DEFAULTS_CONFIG_KEY,
  normalizePurchaseQuotationDefaults,
} from '../../../src/infrastructure/config/purchaseQuotationDefaults.config.js';

describe('normalizePurchaseQuotationDefaults', () => {
  it('expone la key de configuración que leen los tenants', () => {
    expect(PURCHASE_QUOTATION_DEFAULTS_CONFIG_KEY).toBe('purchaseQuotationDefaults');
    expect(DEFAULT_PURCHASE_QUOTATION_DEFAULTS).toEqual({});
  });

  it('copia los escalares tal cual, sin coerción de tipo', () => {
    expect(normalizePurchaseQuotationDefaults({
      U_TIPOOFECOMPRA: 3,
      U_TIPOENT: 'X',
      U_FLAG: false,
    })).toEqual({ U_TIPOOFECOMPRA: 3, U_TIPOENT: 'X', U_FLAG: false });
  });

  // Una configuración ausente o con forma inesperada deja el documento SIN defaults, que es
  // el comportamiento previo a que esta key existiera.
  it.each([[null], [undefined], ['3'], [42], [[{ U_TIPOOFECOMPRA: 3 }]]])(
    'devuelve {} para %p',
    (value) => {
      expect(normalizePurchaseQuotationDefaults(value)).toEqual({});
    }
  );

  it('descarta objetos y arrays para que una config no inyecte estructuras', () => {
    expect(normalizePurchaseQuotationDefaults({
      U_TIPOOFECOMPRA: 3,
      Nested: { a: 1 },
      List: [1, 2],
      Nulo: null,
    })).toEqual({ U_TIPOOFECOMPRA: 3 });
  });

  it('descarta los campos reservados que resuelve el builder', () => {
    expect(normalizePurchaseQuotationDefaults({
      DocumentLines: 'x',
      StockTransferLines: 'y',
      U_TIPOOFECOMPRA: 3,
    })).toEqual({ U_TIPOOFECOMPRA: 3 });
  });
});
