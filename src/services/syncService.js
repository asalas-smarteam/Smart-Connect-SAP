import sapService from '../integrations/sap/sapService.js';
import mappingService from './mapping.service.js';
import hubspotService from '../services/hubspotService.js';

const syncService = {
  async run(config, tenantModels) {
    const startedAt = new Date();
    const clientConfigId = config?.id;

    try {
      if (!config) {
        throw new Error('Client configuration not found');
      }

      const { HubspotCredentials, SyncLog } = tenantModels;

      const credentials = await HubspotCredentials.findById(
        config.hubspotCredentialId
      );

      const rawData = await sapService.fetchData(clientConfigId, tenantModels);

      if (!credentials) {
        await SyncLog.create({
          clientConfigId,
          status: 'error',
          errorMessage: 'No HubSpot credentials assigned to this clientConfig',
          startedAt,
          finishedAt: new Date(),
        });
        return;
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

      const objectType = config.objectType;
      const sapRecords = rawData;

      const mappedRecords = await mappingService.mapRecords(
        sapRecords,
        config.hubspotCredentialId,
        objectType,
        tenantModels
      );

      const mappedRecordsWithRawSap = mappedRecords.map((record, index) => ({
        ...record,
        rawSapData: sapRecords?.[index] ?? null,
      }));

      let hubspotResult = { sent: 0, failed: 0 };

      try {
        hubspotResult = await hubspotService.sendToHubSpot(
          mappedRecordsWithRawSap,
          config,
          objectType,
          tenantModels,
          credentials
        );
      } catch (error) {
        hubspotResult = { sent: 0, failed: mappedRecordsWithRawSap.length };
      }

      const recordsProcessed = mappedRecordsWithRawSap.length;

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
      }
    }
  },
};

export default syncService;
