function base64UrlEncode(buffer) {
  return buffer.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(input) {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

export function buildOAuthState(payload) {
  const json = JSON.stringify(payload);
  return base64UrlEncode(Buffer.from(json, 'utf8'));
}

export function parseOAuthState(state) {
  if (!state) {
    return { clientConfigId: null, tenantKey: null };
  }

  try {
    const json = base64UrlDecode(state);
    const parsed = JSON.parse(json);
    return {
      clientConfigId: parsed?.clientConfigId || null,
      tenantKey: parsed?.tenantKey || null,
    };
  } catch (_error) {
    return { clientConfigId: state, tenantKey: null };
  }
}
