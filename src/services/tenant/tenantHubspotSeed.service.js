import {
  ensureObjectProperty,
  fetchDealPipelines,
  fetchDealStages,
  fetchOwners,
} from '../hubspot/hubspotMetadata.controller.js';

function getTenantModel(tenantConnection, modelName) {
  const model = tenantConnection?.models?.[modelName];
  if (!model) {
    throw new Error(`Tenant model ${modelName} is not registered on tenant connection`);
  }
  return model;
}

export async function seedHubspotMappings({ tenantConnection, hubspotCredential }) {
  const accessToken = hubspotCredential?.accessToken;
  const hubspotCredentialId = hubspotCredential?._id;

  if (!accessToken || !hubspotCredentialId) {
    throw new Error('Valid hubspotCredential with _id and accessToken is required for HubSpot seed');
  }

  const DealPipelineMapping = getTenantModel(tenantConnection, 'DealPipelineMapping');
  const DealStageMapping = getTenantModel(tenantConnection, 'DealStageMapping');
  const OwnerMapping = getTenantModel(tenantConnection, 'OwnerMapping');

  const pipelines = await fetchDealPipelines(accessToken);
  const owners = await fetchOwners(accessToken);

  if (pipelines.length > 0) {
    await DealPipelineMapping.bulkWrite(
      pipelines.map((pipeline) => ({
        updateOne: {
          filter: {
            hubspotCredentialId,
            hubspotPipelineId: pipeline.hubspotPipelineId,
          },
          update: {
            $setOnInsert: {
              hubspotCredentialId,
              hubspotPipelineId: pipeline.hubspotPipelineId,
              hubspotPipelineLabel: pipeline.hubspotPipelineLabel,
              sapPipelineKey: null,
              description: null,
            },
          },
          upsert: true,
        },
      })),
      { ordered: false }
    );
  }

  const allStages = [];
  for (const pipeline of pipelines) {
    // eslint-disable-next-line no-await-in-loop
    const pipelineStages = await fetchDealStages(accessToken, pipeline.hubspotPipelineId);
    allStages.push(...pipelineStages);
  }

  if (allStages.length > 0) {
    await DealStageMapping.bulkWrite(
      allStages.map((stage) => ({
        updateOne: {
          filter: {
            hubspotCredentialId,
            hubspotPipelineId: stage.hubspotPipelineId,
            hubspotStageId: stage.hubspotStageId,
          },
          update: {
            $setOnInsert: {
              hubspotCredentialId,
              hubspotPipelineId: stage.hubspotPipelineId,
              hubspotStageId: stage.hubspotStageId,
              hubspotStageLabel: stage.hubspotStageLabel,
              sapStageKey: null,
              description: null,
            },
          },
          upsert: true,
        },
      })),
      { ordered: false }
    );
  }

  if (owners.length > 0) {
    await OwnerMapping.bulkWrite(
      owners.map((owner) => ({
        updateOne: {
          filter: {
            hubspotCredentialId,
            hubspotOwnerId: owner.hubspotOwnerId,
          },
          update: {
            $setOnInsert: {
              hubspotCredentialId,
              hubspotOwnerId: owner.hubspotOwnerId,
              hubspotOwnerEmail: owner.hubspotOwnerEmail,
              hubspotOwnerName: owner.hubspotOwnerName,
              sapOwnerId: null,
              sapOwnerName: null,
              active: true,
              source: 'hubspot_seed',
            },
          },
          upsert: true,
        },
      })),
      { ordered: false }
    );
  }

  return {
    pipelinesCount: pipelines.length,
    stagesCount: allStages.length,
    ownersCount: owners.length,
  };
}

export async function seedCreateFieldsHubspot({ hubspotCredential }) {
  const accessToken = hubspotCredential?.accessToken;
  const hubspotCredentialId = hubspotCredential?._id;

  if (!accessToken || !hubspotCredentialId) {
    throw new Error('Valid hubspotCredential with _id and accessToken is required for HubSpot field seed');
  }

  // TODO: CREAR EL GRUPO PARA UNIR CON LAS PROPIEDADES DE SAP

  const fieldsToEnsure = [
    { objectType: 'contacts', label: 'ID SAP', name: 'idsap' },
    { objectType: 'contacts', label: 'Código Interno SAP', name: 'internalcode' },
    {
      objectType: 'contacts',
      label: 'Lista de precios',
      name: 'pricelist',
      type: 'enumeration',
      fieldType: 'select',
      options: [
        { label: '1', value: '1' },
        { label: '2', value: '2' },
        { label: '3', value: '3' },
        { label: '4', value: '4' },
        { label: '5', value: '5' },
      ],
    },
    { objectType: 'companies', label: 'ID SAP', name: 'idsap' },
    { objectType: 'companies', label: 'Correo electronico', name: 'email' },
    {
      objectType: 'companies',
      label: 'Lista de precios',
      name: 'pricelist',
      type: 'enumeration',
      fieldType: 'select',
      options: [
        { label: '1', value: '1' },
        { label: '2', value: '2' },
        { label: '3', value: '3' },
        { label: '4', value: '4' },
        { label: '5', value: '5' },
      ],
    },
    { objectType: 'products', label: 'Código de producto', name: 'itemCode' },
    { objectType: 'products', label: 'Stock En Orden', name: 'ordered' },
    { objectType: 'products', label: 'Stock comprometido', name: 'committed' },
    { objectType: 'products', label: 'Stock disponible', name: 'available' },
    { objectType: 'products', label: 'Stock Total', name: 'instock' },
  ];

  const results = [];
  for (const field of fieldsToEnsure) {
    // eslint-disable-next-line no-await-in-loop
    const ensured = await ensureObjectProperty(accessToken, field);
    results.push(ensured);
  }

  return {
    totalFields: results.length,
    createdFields: results.filter((item) => item.created).length,
    existingFields: results.filter((item) => !item.created).length,
    results,
  };
}
