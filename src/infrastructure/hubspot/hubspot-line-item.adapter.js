import { batchUpdateLineItems, createLineItem } from '../../services/hubspotClient.js';

export const hubspotLineItemAdapter = Object.freeze({
  batchUpdateLineItems,
  createLineItem,
});

export default hubspotLineItemAdapter;

