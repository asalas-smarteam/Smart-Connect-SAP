import { SaaSClient, Subscription } from '../config/database.js';

function isSubscriptionActive(subscription) {
  return (
    subscription
    && subscription.status === 'active'
    && subscription.paymentStatus === 'paid'
  );
}

export async function resolveActiveTenant({ tenantKey, tenantId, portalId }) {
  let client = null;

  if (tenantId) {
    client = await SaaSClient.findById(tenantId);
  } else if (tenantKey) {
    client = await SaaSClient.findOne({ tenantKey });
  } else if (portalId) {
    client = await SaaSClient.findOne({ 'hubspot.portalId': portalId });
  }

  if (!client || client.status !== 'active') {
    return null;
  }

  const subscription = await Subscription.findOne({ clientId: client._id }).sort({ startedAt: -1 });

  if (!isSubscriptionActive(subscription)) {
    return null;
  }

  return { client, subscription };
}

export async function listActiveTenants() {
  const activeClients = await SaaSClient.find({ status: 'active' });
  const results = [];

  for (const client of activeClients) {
    const subscription = await Subscription.findOne({ clientId: client._id }).sort({ startedAt: -1 });

    if (isSubscriptionActive(subscription)) {
      results.push({ client, subscription });
    }
  }

  return results;
}
