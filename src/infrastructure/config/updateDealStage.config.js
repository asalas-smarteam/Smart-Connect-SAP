export const UPDATE_DEAL_STAGE_CONFIG_KEY = 'updateDealStage';

export const DEFAULT_UPDATE_DEAL_STAGE_CONFIG = {
  isRequired: false,
  dealstage: null,
};

function normalizeUpdateDealStageConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_UPDATE_DEAL_STAGE_CONFIG };
  }

  const isRequired = value.isRequired === true || value.isRequired === 'true';
  const dealstage = value.dealstage ?? null;

  return { isRequired, dealstage };
}

/**
 * Reads the tenant `updateDealStage` configuration used by the SAP -> HubSpot deal
 * sync to decide the target dealstage. Pipelines are never moved by this flow.
 */
export async function getUpdateDealStageConfig({ tenantContext, tenantModels } = {}) {
  const Configuration = (tenantContext?.tenantModels ?? tenantModels)?.Configuration;

  if (typeof Configuration?.findOne !== 'function') {
    return { ...DEFAULT_UPDATE_DEAL_STAGE_CONFIG };
  }

  const query = Configuration.findOne({ key: UPDATE_DEAL_STAGE_CONFIG_KEY });
  const configuration = typeof query?.lean === 'function' ? await query.lean() : await query;

  return normalizeUpdateDealStageConfig(configuration?.value);
}

export default { getUpdateDealStageConfig, UPDATE_DEAL_STAGE_CONFIG_KEY, DEFAULT_UPDATE_DEAL_STAGE_CONFIG };
