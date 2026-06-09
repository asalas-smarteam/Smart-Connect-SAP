export class HubspotSyncAdapter {
  constructor({ sendMappedItemsToHubspot } = {}) {
    this.sendMappedItemsToHubspot = sendMappedItemsToHubspot;
  }

  async send({ mappedRecords, config, objectType, tenantContext, credentials }) {
    if (!this.sendMappedItemsToHubspot?.execute) {
      throw new Error('HubSpot sync transport dependency is required');
    }

    const result = await this.sendMappedItemsToHubspot.execute({
      mappedItems: Array.isArray(mappedRecords) ? mappedRecords : [],
      clientConfig: config,
      objectType,
      tenantModels: tenantContext?.tenantModels,
      credentials,
    });

    return {
      sent: result?.sent ?? 0,
      failed: result?.failed ?? 0,
      created: result?.created ?? 0,
      updated: result?.updated ?? Math.max((result?.sent ?? 0) - (result?.created ?? 0), 0),
    };
  }
}

export default HubspotSyncAdapter;
