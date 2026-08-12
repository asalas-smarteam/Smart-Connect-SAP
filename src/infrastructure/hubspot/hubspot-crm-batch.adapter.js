import {
  associateObjectsDefault,
  batchAssociateDefault,
  batchCreateObjects,
  batchUpdateObjects,
  listAllObjects,
  listWritablePropertyNames,
} from './hubspotClient.js';

export const hubspotCrmBatchAdapter = Object.freeze({
  associateObjectsDefault,
  batchAssociateDefault,
  batchCreateObjects,
  batchUpdateObjects,
  listAllObjects,
  listWritablePropertyNames,
});

export default hubspotCrmBatchAdapter;
