import logger from '../core/logger.js';
import { requireTenantModels } from '../utils/tenantModels.js';

export const echoTest = async (req, reply) => {
  const { body } = req;

  logger.info('Echo test received', body);

  return reply.send({ ok: true, body });
};
/*
{
  eventId: 797713315,
  subscriptionId: 6174090,
  portalId: 50564010,
  appId: 31481725,
  occurredAt: 1775764313528,
  subscriptionType: "deal.associationChange",
  attemptNumber: 0,
  changeSource: "USER",
  associationType: "DEAL_TO_LINE_ITEM",
  fromObjectId: 58986911596,
  toObjectId: 54154480712,
  associationRemoved: false,
  isPrimaryAssociation: false,
}


{
  eventId: 797713315,
  subscriptionId: 6174090,
  portalId: 50564010,
  appId: 31481725,
  occurredAt: 1775764313528,
  subscriptionType: "deal.associationChange",
  attemptNumber: 1,
  changeSource: "USER",
  associationType: "DEAL_TO_LINE_ITEM",
  fromObjectId: 58986911596,
  toObjectId: 54154480712,
  associationRemoved: false,
  isPrimaryAssociation: false,
}

{
  eventId: 797713315,
  subscriptionId: 6174090,
  portalId: 50564010,
  appId: 31481725,
  occurredAt: 1775764313528,
  subscriptionType: "deal.associationChange",
  attemptNumber: 2,
  changeSource: "USER",
  associationType: "DEAL_TO_LINE_ITEM",
  fromObjectId: 58986911596,
  toObjectId: 54154480712,
  associationRemoved: false,
  isPrimaryAssociation: false,
}
*/