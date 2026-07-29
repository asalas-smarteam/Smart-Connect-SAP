import {
  associateObjects,
  batchAssociateDefault,
  batchCreateObjects,
  batchUpdateObjects,
  listAllObjects,
  listWritablePropertyNames,
} from './hubspotClient.js';

export const hubspotCrmBatchAdapter = Object.freeze({
  associateObjects,
  batchAssociateDefault,
  batchCreateObjects,
  batchUpdateObjects,
  listAllObjects,
  listWritablePropertyNames,
});

export default hubspotCrmBatchAdapter;
