import hubspotService from './hubspotService.js';

export class HubspotSyncAdapter {
  async send({ mappedRecords, config, objectType, tenantModels, credentials }) {
    return hubspotService.sendToHubSpot(
      mappedRecords,
      config,
      objectType,
      tenantModels,
      credentials
    );
  }
}

export default HubspotSyncAdapter;

