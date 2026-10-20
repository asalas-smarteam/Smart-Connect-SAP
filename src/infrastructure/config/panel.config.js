import dotenv from 'dotenv';

dotenv.config();

// Configuración del panel de soporte (/panel/api). PANEL_JWT_SECRET es distinto de JWT_SECRET a
// propósito: tenantResolver acepta cualquier bearer firmado con JWT_SECRET que traiga tenantKey,
// así que con el mismo secreto una sesión del panel abriría los webhooks de su tenant.
// Sin PANEL_JWT_SECRET el panel no se registra (fail closed).
export const panelConfig = Object.freeze({
  jwtSecret: process.env.PANEL_JWT_SECRET || null,
  // Solo para comprobar que PANEL_JWT_SECRET no sea igual al de los webhooks.
  tenantJwtSecret: process.env.JWT_SECRET || null,
  minSecretLength: 32,
  // IPs o rangos CIDR de los proxies propios (separados por coma). Sin ellos, el límite de
  // logins por IP queda apagado: detrás del proxy todas las IPs serían la misma.
  trustedProxies: String(process.env.PANEL_TRUSTED_PROXIES ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean),
  loginEmailMaxAttempts: 5,
  loginIpMaxAttempts: 30,
  loginWindowSeconds: 15 * 60,
  sessionTtlSeconds: 8 * 60 * 60,
  cookieName: 'panel_session',
  // El navegador ve la API en <dominio del panel>/api; el proxy reenvía a /panel/api.
  cookiePath: '/api',
});

export default panelConfig;
