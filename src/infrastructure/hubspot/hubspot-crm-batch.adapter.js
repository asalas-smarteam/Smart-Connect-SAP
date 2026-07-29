import {
  associateObjects,
  batchAssociateDefault,
  batchCreateObjects,
  batchReadObjectsByProperty,
  batchUpdateObjects,
  searchObjectsByPropertyIn,
} from './hubspotClient.js';

export const hubspotCrmBatchAdapter = Object.freeze({
  associateObjects,
  batchAssociateDefault,
  batchCreateObjects,
  batchReadObjectsByProperty,
  batchUpdateObjects,
  searchObjectsByPropertyIn,
});

export default hubspotCrmBatchAdapter;
