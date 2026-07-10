export const LINE_ITEM_PRICE_STRATEGY_CONFIG_KEY = 'lineItemPriceStrategy';

export const LINE_ITEM_PRICE_STRATEGIES = Object.freeze({
  BUSINESS_PARTNER: 'businessPartner_LineItemPrice',
  DEAL_PRICE_LIST: 'dealPriceList_LineItemPrice',
});

// Sin documento lineItemPriceStrategy en Configurations el tenant usa el flujo
// original (precio por business partner + miscelaneo) sin ningún cambio.
export const DEFAULT_LINE_ITEM_PRICE_STRATEGY = LINE_ITEM_PRICE_STRATEGIES.BUSINESS_PARTNER;

// Defaults de la strategy dealPriceList. Las propiedades de lista de precios
// (deal y line item) no tienen default: son específicas de cada portal y la
// strategy falla con error claro si faltan en la config.
export const DEFAULT_DEAL_PRICE_LIST_CONFIG = Object.freeze({
  dealPriceListProperty: null,
  lineItemPriceListProperty: null,
  dealCurrencyProperty: 'deal_currency_code',
  safePriceProperty: 'safe_price_value',
  currencyCodes: Object.freeze({}),
});
