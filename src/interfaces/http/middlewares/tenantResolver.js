import crypto from 'crypto';
import env from '#infrastructure/config/env.js';
import { SaaSClient, Subscription } from '#infrastructure/database/master/database.js';
import { getTenantConnection, getTenantModels } from '#infrastructure/database/tenant/tenantDatabase.js';

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

// Solo las suscripciones de webhooks de HubSpot identifican al tenant por portalId: llegan con
// un array de eventos de formato fijo, sin headers ni campos propios. Cualquier otro body (un
// objeto, o ninguno) no aporta portalId y termina en 403 en vez de un TypeError con 500.
function extractPortalId(req) {
  const firstEvent = Array.isArray(req.body) ? req.body[0] : null;
  const portalId = firstEvent?.portalId ?? req.query?.portalId;
  const normalized = String(portalId ?? '').trim();
  return normalized || null;
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

async function attachTenant(req, reply, client) {
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
}

// Resolver de los webhooks de HubSpot. Acepta los identificadores que HubSpot puede mandar hoy
// (x-tenant-id de los workflows con custom code, portalId de las suscripciones), así que no
// prueba identidad: autenticar esas llamadas es la Fase B (firma / secreto por tenant).
export async function tenantResolver(req, reply) {
  const token = extractBearerToken(req);
  let client = await resolveTenantByToken(token);
  if (!token) {
    const tenantId = extractTenantId(req);
    if (tenantId) {
      client = await SaaSClient.findOne({ _id: tenantId });
    } else {
      const portalId = extractPortalId(req);
      if (portalId) {
        client = await SaaSClient.findOne({ 'hubspot.portalId': portalId });
      }
    }
  }

  return attachTenant(req, reply, client);
}

// Resolver de las rutas administrativas. Va siempre detrás de internalKeyAuthOnly (ver
// adminAuth.js): la llave interna prueba que quien llama es del equipo y este resolver solo
// elige el tenant, y únicamente por header. Query, body, portalId y tokens quedan fuera a
// propósito para que no exista un segundo camino hacia la configuración de un tenant.
export async function adminTenantResolver(req, reply) {
  const tenantId = String(req.headers?.['x-tenant-id'] ?? '').trim();
  if (!tenantId) {
    return respond(reply, 400, { error: 'x-tenant-id header is required' });
  }

  const client = await SaaSClient.findOne({ _id: tenantId });
  return attachTenant(req, reply, client);
}
