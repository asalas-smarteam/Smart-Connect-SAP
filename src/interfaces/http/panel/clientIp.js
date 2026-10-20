import net from 'net';

// IP del cliente para el panel, sin activar trustProxy en Fastify (cambiaría el req.ip que
// loguea src/main/app.js para todas las rutas). Se confía en X-Forwarded-For solo a través de
// los proxies de PANEL_TRUSTED_PROXIES, recorriendo la cadena de derecha a izquierda como
// proxy-addr: lo que un cliente agregue a la izquierda del header nunca se lee.

const IPV4_MAPPED_PREFIX = '::ffff:';

export function normalizeIp(value) {
  let ip = String(value ?? '').trim();
  if (!ip) {
    return null;
  }

  // [::1]:443 o [2001:db8::1]
  const bracketed = ip.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) {
    ip = bracketed[1];
  } else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) {
    // 1.2.3.4:5678
    ip = ip.slice(0, ip.lastIndexOf(':'));
  }

  if (ip.toLowerCase().startsWith(IPV4_MAPPED_PREFIX) && net.isIPv4(ip.slice(IPV4_MAPPED_PREFIX.length))) {
    ip = ip.slice(IPV4_MAPPED_PREFIX.length);
  }

  return net.isIP(ip) ? ip : null;
}

function ipFamily(ip) {
  return net.isIPv6(ip) ? 'ipv6' : 'ipv4';
}

export function parseTrustedProxies(value) {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function createTrustedProxyMatcher(entries = []) {
  const blockList = new net.BlockList();
  const invalidEntries = [];
  let validCount = 0;

  entries.forEach((entry) => {
    const [address, prefix, ...rest] = String(entry).split('/');
    const ip = normalizeIp(address);
    const prefixLength = prefix === undefined ? null : Number(prefix);
    const maxPrefix = ip && net.isIPv6(ip) ? 128 : 32;

    if (
      !ip
      || rest.length > 0
      || (prefix !== undefined && (!/^\d+$/.test(prefix) || prefixLength > maxPrefix))
    ) {
      invalidEntries.push(entry);
      return;
    }

    if (prefixLength === null) {
      blockList.addAddress(ip, ipFamily(ip));
    } else {
      blockList.addSubnet(ip, prefixLength, ipFamily(ip));
    }
    validCount += 1;
  });

  return {
    enabled: validCount > 0,
    invalidEntries,
    isTrusted(ip) {
      const normalized = normalizeIp(ip);
      return Boolean(normalized) && validCount > 0 && blockList.check(normalized, ipFamily(normalized));
    },
  };
}

export function resolveClientIp({ socketAddress, forwardedFor, matcher }) {
  const socketIp = normalizeIp(socketAddress);
  if (!matcher?.enabled || !socketIp) {
    return socketIp;
  }

  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : String(forwardedFor ?? '');
  const chain = [
    ...header.split(',').map(normalizeIp).filter(Boolean),
    socketIp,
  ];

  for (let index = chain.length - 1; index >= 0; index -= 1) {
    if (!matcher.isTrusted(chain[index])) {
      return chain[index];
    }
  }

  return chain[0];
}

function expandIpv6(ip) {
  const [head, tail = ''] = ip.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = ip.includes('::') && tail ? tail.split(':') : [];
  const missing = 8 - headParts.length - tailParts.length;
  const parts = ip.includes('::')
    ? [...headParts, ...Array(missing).fill('0'), ...tailParts]
    : headParts;
  return parts.map((part) => part.padStart(4, '0').toLowerCase());
}

// Clave del límite de logins por IP. Una IPv6 se agrupa por su /64: quien tiene un bloque IPv6
// puede cambiar los últimos 64 bits en cada request y, con la dirección completa como clave,
// nunca chocaría con el límite. La IP completa se sigue usando para la auditoría.
export function rateLimitKeyForIp(ip) {
  const normalized = normalizeIp(ip);
  if (!normalized || !net.isIPv6(normalized)) {
    return normalized;
  }

  return `${expandIpv6(normalized).slice(0, 4).join(':')}::/64`;
}
