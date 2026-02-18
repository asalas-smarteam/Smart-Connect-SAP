import crypto from 'crypto';
import env from '../config/env.js';
import { SaaSClient, Subscription } from '../config/database.js';
import { getTenantConnection, getTenantModels } from '../config/tenantDatabase.js';

const { JWT_SECRET } = env;

function base64UrlDecode(input) {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function base64UrlEncode(buffer) {
  return buffer.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function verifyJwt(token, secret) {
  if (!secret) {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const [header, payload, signature] = parts;
  const data = `${header}.${payload}`;
  const expected = base64UrlEncode(crypto.createHmac('sha256', secret).update(data).digest());
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (signatureBuffer.length !== expectedBuffer.length) {
    return null;
  }
  if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }
  try {
    const payloadJson = base64UrlDecode(payload);
    const parsed = JSON.parse(payloadJson);
    if (parsed.exp && Date.now() / 1000 >= parsed.exp) {
      return null;
    }
    return parsed;
  } catch (error) {
    return null;
  }
}

function extractBearerToken(req) {
  const authHeader = req.headers?.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }
  return null;
}

function extractTenantId(req) {
  const headerTenantId = req.headers?.['x-tenant-id'];
  if (headerTenantId) {
    return headerTenantId;
  }
  if (req.query?.tenantId) {
    return req.query.tenantId;
  }
  if (req.body?.tenantId) {
    return req.body.tenantId;
  }
  return null;
}

async function resolveTenantByToken(token) {
  if (!token) {
    return null;
  }

  const payload = verifyJwt(token, JWT_SECRET);
  if (payload?.tenantKey) {
    return SaaSClient.findOne({ tenantKey: payload.tenantKey });
  }
  if (payload?.portalId) {
    return SaaSClient.findOne({ 'hubspot.portalId': payload.portalId });
  }

  return SaaSClient.findOne({ 'hubspot.accessToken': token });
}

function respond(reply, statusCode, payload) {
  if (reply?.code) {
    reply.code(statusCode).send(payload);
    return true;
  }
  return false;
}

export async function tenantResolver(req, reply) {
  try {
    const token = extractBearerToken(req);
    let client = await resolveTenantByToken(token);
    if (!token) {
      const tenantId = extractTenantId(req);
      if (tenantId) {
        client = await SaaSClient.findOne({ _id: tenantId });
      }
    }

    if (!client) {
      return respond(reply, 403, { error: 'Tenant not found' });
    }

    if (client.status !== 'active') {
      return respond(reply, 402, { error: 'Subscription inactive' });
    }

    const subscription = await Subscription.findOne({ clientId: client._id }).sort({ startedAt: -1 });

    if (!subscription || subscription.status !== 'active' || subscription.paymentStatus !== 'paid') {
      return respond(reply, 402, { error: 'Subscription inactive' });
    }

    const tenantDb = await getTenantConnection(client.tenantKey);
    const tenantModels = await getTenantModels(client.tenantKey);

    req.tenant = {
      client,
      subscription,
    };
    req.tenantKey = client.tenantKey;
    req.tenantDb = tenantDb;
    req.tenantModels = tenantModels;

    return undefined;
  } catch (error) {
    throw error;
  }
}
