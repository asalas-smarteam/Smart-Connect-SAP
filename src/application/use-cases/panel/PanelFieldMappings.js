import { toFieldMappingView } from '#domain/panel/fieldMappingView.js';
import { fail, panelReasons } from './panelReasons.js';
import { resolveScopeTenant } from './tenantScope.js';

const TIMEOUT_MESSAGE = 'La consulta tardó demasiado. Intenta de nuevo.';

// Mapeo de campos de una empresa (plan 6, contrato 08, I1 e I2). Solo lectura.
// El tenant llega por scope: el de la sesión (ruta de cliente) o el :tenantKey de la ruta de
// staff, que se valida contra el directorio de empresas antes de abrir la base (igual que
// PanelOperations).
export class PanelFieldMappings {
  constructor({ fieldMappingReader, tenantDirectory, logger = null }) {
    this.reader = fieldMappingReader;
    this.tenantDirectory = tenantDirectory;
    this.logger = logger;
  }

  async resolveTenant(scope) {
    return resolveScopeTenant(this.tenantDirectory, scope);
  }

  async list({ scope }) {
    try {
      const tenant = await this.resolveTenant(scope);
      if (!tenant.ok) {
        return tenant;
      }
      const { items, truncated } = await this.reader.listFieldMappings(tenant.tenantKey);
      if (truncated) {
        this.logger?.warn?.({ msg: 'Panel field mappings: list truncated', tenantKey: tenant.tenantKey, shown: items.length });
      }
      return { ok: true, data: { items: items.map(toFieldMappingView) } };
    } catch (error) {
      if (error?.code === 'PANEL_QUERY_TIMEOUT') {
        return fail(panelReasons.QUERY_TIMEOUT, TIMEOUT_MESSAGE);
      }
      throw error;
    }
  }
}

export default PanelFieldMappings;
