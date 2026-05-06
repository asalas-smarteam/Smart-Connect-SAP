export class LineItemPriceCredentialRepository {
  async resolveHubspotCredentials() {
    throw new Error('Not implemented');
  }

  async resolveSapCredentials() {
    throw new Error('Not implemented');
  }

  async resolveTenantPriceList() {
    throw new Error('Not implemented');
  }

  async resolveWarehouseStockProperties() {
    throw new Error('Not implemented');
  }
}

export class SapLineItemPriceClientPort {
  async fetchBusinessPartnerPrice() {
    throw new Error('Not implemented');
  }

  async fetchItemPrices() {
    throw new Error('Not implemented');
  }
}

export class HubspotLineItemPriceClientPort {
  async getAccessToken() {
    throw new Error('Not implemented');
  }

  async updateLineItems() {
    throw new Error('Not implemented');
  }

  async updateProducts() {
    throw new Error('Not implemented');
  }

  async updateDealAmount() {
    throw new Error('Not implemented');
  }
}
