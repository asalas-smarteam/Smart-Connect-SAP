import { findDealByName, updateDeal, createDeal } from './hubspotClient.js';

export const hubspotDealAdapter = Object.freeze({
  findDealByName,
  createDeal,
  updateDeal,
});

export default hubspotDealAdapter;

