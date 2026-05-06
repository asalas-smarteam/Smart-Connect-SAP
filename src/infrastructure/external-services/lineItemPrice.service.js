import buildSyncLineItemPrices from '#composition/line-item-prices.composition.js';

const lineItemPriceService = {
  async syncPrices(payload, context) {
    const syncLineItemPrices = buildSyncLineItemPrices();
    return syncLineItemPrices.execute(payload, context);
  },
};

export default lineItemPriceService;
