import { toOwnerMappingView } from '#domain/panel/ownerMappingView.js';
import { fail, panelReasons } from './panelReasons.js';
import { resolveScopeTenant } from './tenantScope.js';

const TIMEOUT_MESSAGE = 'La consulta tardó demasiado. Intenta de nuevo.';

// Mapeo de responsables de una empresa (plan 11, contrato 13, N1 y N2). Solo lectura.
// El tenant llega por scope: el de la sesión (ruta de cliente) o el :tenantKey de la ruta de
// staff, validado contra el directorio de empresas antes de abrir la base.
export class PanelOwnerMappings {
  constructor({ ownerMappingReader, tenantDirectory, logger = null }) {
    this.reader = ownerMappingReader;
    this.tenantDirectory = tenantDirectory;
    this.logger = logger;
  }

  async list({ scope }) {
    try {
      const tenant = await resolveScopeTenant(this.tenantDirectory, scope);
      if (!tenant.ok) {
        return tenant;
      }
      const { items, truncated } = await this.reader.listOwnerMappings(tenant.tenantKey);
      if (truncated) {
        this.logger?.warn?.({ msg: 'Panel owner mappings: list truncated', tenantKey: tenant.tenantKey, shown: items.length });
      }
      return { ok: true, data: { items: items.map(toOwnerMappingView) } };
    } catch (error) {
      if (error?.code === 'PANEL_QUERY_TIMEOUT') {
        return fail(panelReasons.QUERY_TIMEOUT, TIMEOUT_MESSAGE);
      }
      throw error;
    }
  }
}

export default PanelOwnerMappings;
