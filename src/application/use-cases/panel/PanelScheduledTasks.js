import { VIEW_SIDES } from '#domain/panel/operationViews.js';
import { toScheduledTaskView } from '#domain/panel/scheduledTaskView.js';
import { fail, panelReasons } from './panelReasons.js';
import { resolveScopeTenant } from './tenantScope.js';

const TIMEOUT_MESSAGE = 'La consulta tardó demasiado. Intenta de nuevo.';

// Tareas programadas de una empresa (plan 7, contrato 09, J1 a J5). Solo lectura.
// Ruta de cliente (sin :tenantKey) → vista de cliente; ruta de staff → vista de Smarteam.
// Las próximas ejecuciones vienen del programador (Redis): si fallan o tardan, la lista sale igual
// con nextRunAt en null.
export class PanelScheduledTasks {
  constructor({ scheduledTaskReader, scheduledRunReader, tenantDirectory, logger = null }) {
    this.reader = scheduledTaskReader;
    this.runReader = scheduledRunReader;
    this.tenantDirectory = tenantDirectory;
    this.logger = logger;
  }

  async nextRuns(tenantKey) {
    try {
      return await this.runReader.nextRunsFor(tenantKey);
    } catch (error) {
      this.logger?.warn?.({ msg: 'Panel scheduled tasks: next runs unavailable', tenantKey, error: error?.message });
      return new Map();
    }
  }

  async list({ scope }) {
    try {
      const tenant = await resolveScopeTenant(this.tenantDirectory, scope);
      if (!tenant.ok) {
        return tenant;
      }
      const side = scope?.routeTenantKey === undefined ? VIEW_SIDES.CLIENTE : VIEW_SIDES.SMARTEAM;
      const [{ items, truncated }, runs] = await Promise.all([
        this.reader.listScheduledTasks(tenant.tenantKey),
        this.nextRuns(tenant.tenantKey),
      ]);
      if (truncated) {
        this.logger?.warn?.({ msg: 'Panel scheduled tasks: list truncated', tenantKey: tenant.tenantKey, shown: items.length });
      }
      return {
        ok: true,
        data: {
          items: items.map((raw) => toScheduledTaskView(raw, { side, nextRunAt: runs.get(String(raw._id)) ?? null })),
        },
      };
    } catch (error) {
      if (error?.code === 'PANEL_QUERY_TIMEOUT') {
        return fail(panelReasons.QUERY_TIMEOUT, TIMEOUT_MESSAGE);
      }
      throw error;
    }
  }
}

export default PanelScheduledTasks;
