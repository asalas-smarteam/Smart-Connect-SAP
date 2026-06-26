import * as hubspotClient from '../hubspotClient.js';
import dealMappingResolver from '#infrastructure/database/repositories/dealMappingResolver.js';
import { getMappedOwnerId } from '#infrastructure/database/repositories/ownerMapping.service.js';
import { getUpdateDealStageConfig } from '#infrastructure/config/updateDealStage.config.js';

export async function preprocess({ item, clientConfig, tenantModels }) {
  const properties = item.properties ?? {};
  const { pipeline, dealstage, hubspot_owner_id } = properties;

  if (pipeline) {
    // Legacy/webhook-style payloads that carry an explicit pipeline still resolve
    // pipeline + stage through the configured mappings.
    const mappedPipeline = await dealMappingResolver.resolvePipeline(
      clientConfig.hubspotCredentialId,
      pipeline,
      tenantModels
    );
    if (!mappedPipeline) {
      throw new Error('Pipeline mapping not found.');
    }

    const mappedStage = await dealMappingResolver.resolveStage(
      clientConfig.hubspotCredentialId,
      pipeline,
      dealstage,
      tenantModels
    );
    if (!mappedStage) {
      throw new Error('Stage mapping not found.');
    }

    item.properties.pipeline = mappedPipeline.hubspotPipelineId;
    item.properties.dealstage = mappedStage.hubspotStageId;
  } else {
    // SAP -> HubSpot sync: pipelines are never moved. The target stage is driven by the
    // tenant `updateDealStage` configuration. When isRequired, force the configured
    // stage; otherwise keep the dealstage produced by the field mapping.
    const { isRequired, dealstage: configuredStage } = await getUpdateDealStageConfig({ tenantModels });
    if (isRequired && configuredStage) {
      item.properties.dealstage = configuredStage;
    }
  }

  if (hubspot_owner_id) {
    const mappedOwner = await getMappedOwnerId(
      clientConfig.hubspotCredentialId,
      hubspot_owner_id,
      tenantModels
    );

    if (mappedOwner) {
      item.properties.hubspot_owner_id = mappedOwner;
    }
  }
}

export async function find({ token, item }) {
  const sapDocEntry = item?.properties?.sap_docentry;

  if (sapDocEntry !== undefined && sapDocEntry !== null && sapDocEntry !== '') {
    const existingByDocEntry = await hubspotClient.findDealByProperty(
      token,
      'sap_docentry',
      sapDocEntry
    );

    if (existingByDocEntry) {
      return existingByDocEntry;
    }
  }

  const dealName = item?.properties?.dealname;

  if (!dealName) {
    return null;
  }

  return hubspotClient.findDealByName(token, dealName);
}

export async function create({ token, item }) {
  return hubspotClient.createDeal(token, item);
}

export async function update({ token, id, item }) {
  return hubspotClient.updateDeal(token, id, item);
}

export default {
  find,
  create,
  update,
  preprocess,
};
