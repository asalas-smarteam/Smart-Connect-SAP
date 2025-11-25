import sapService from '../integrations/sap/sapService.js';
import mappingService from './mapping.service.js';
import hubspotService from '../services/hubspotService.js';
import { ClientConfig, SyncLog, HubspotCredentials } from '../config/database.js';

const syncService = {
  async run(clientConfigId) {
    const startedAt = new Date();
    let config;

    try {
      config = await ClientConfig.findByPk(clientConfigId);

      if (!config) {
        throw new Error('Client configuration not found');
      }

      const rawData = await sapService.fetchData(clientConfigId);

      const credentials = await HubspotCredentials.findOne({
        where: { clientConfigId: config.id },
      });

      if (!credentials) {
        throw new Error('HubSpot credentials not found for client');
      }

      if (!rawData || rawData.length === 0) {
        await SyncLog.create({
          clientConfigId,
          status: 'success',
          recordsProcessed: 0,
          sent: 0,
          failed: 0,
          startedAt,
          finishedAt: new Date(),
        });

        config.lastRun = new Date();
        await config.save();
        return;
      }

      const objectType = 'contact';
      const sapRecords = rawData;

      const mappedRecords = await mappingService.mapRecords(
        sapRecords,
        credentials.id,
        objectType
      );

      let hubspotResult = { sent: 0, failed: 0 };

      try {
        hubspotResult = await hubspotService.sendToHubSpot(
          mappedRecords,
          config,
          'contact'
        );
      } catch (error) {
        hubspotResult = { sent: 0, failed: mappedRecords.length };
      }

      const recordsProcessed = mappedRecords.length;

      await SyncLog.create({
        clientConfigId,
        status: 'success',
        recordsProcessed,
        sent: hubspotResult.sent,
        failed: hubspotResult.failed,
        startedAt,
        finishedAt: new Date(),
      });

      config.lastRun = new Date();
      await config.save();
    } catch (error) {
      await SyncLog.create({
        clientConfigId,
        status: 'error',
        errorMessage: error.message,
        startedAt,
        finishedAt: new Date(),
      });

      if (config) {
        config.lastError = error.message;
        await config.save();
      } else {
        await ClientConfig.update(
          { lastError: error.message },
          { where: { id: clientConfigId } }
        );
      }
    }
  },
};

export default syncService;
