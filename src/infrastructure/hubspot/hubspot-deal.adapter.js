import { findDealByName, updateDeal, createDeal } from '../../services/hubspotClient.js';

export const hubspotDealAdapter = Object.freeze({
  findDealByName,
  createDeal,
  updateDeal,
});

export default hubspotDealAdapter;

