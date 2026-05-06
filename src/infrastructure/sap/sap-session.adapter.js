import sapSessionManager, { isSessionInvalidError } from './sapSessionManager.js';

export { isSessionInvalidError };

export const sapSessionAdapter = Object.freeze({
  resolveTenantKey: sapSessionManager.resolveTenantKey,
  getSessionCookie: sapSessionManager.getSessionCookie,
  invalidateSession: sapSessionManager.invalidateSession,
  isSessionInvalidError,
});

export default sapSessionAdapter;

