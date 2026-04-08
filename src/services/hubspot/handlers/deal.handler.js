import * as hubspotClient from '../../hubspotClient.js';
import dealMappingResolver from '../../dealMappingResolver.js';
import { getMappedOwnerId } from '../../ownerMapping.service.js';

export async function preprocess({ item, clientConfig, tenantModels }) {
  const { pipeline, dealstage, hubspot_owner_id } = item.properties ?? {};

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

  const mappedOwner = await getMappedOwnerId(
    clientConfig.hubspotCredentialId,
    hubspot_owner_id,
    tenantModels
  );

  if (mappedOwner) {
    item.properties.hubspot_owner_id = mappedOwner;
  }
}

export async function find({ token, item }) {
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
