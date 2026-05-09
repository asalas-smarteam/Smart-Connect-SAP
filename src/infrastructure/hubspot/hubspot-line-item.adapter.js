import { batchUpdateLineItems, createLineItem } from './hubspotClient.js';

export const hubspotLineItemAdapter = Object.freeze({
  batchUpdateLineItems,
  createLineItem,
});

export default hubspotLineItemAdapter;

