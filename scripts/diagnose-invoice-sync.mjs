/**
 * Diagnóstico SOLO LECTURA del flujo factura SAP -> etapa del negocio en HubSpot.
 *
 * No escribe en Mongo, no llama a HubSpot y no llama a SAP: solo lee la
 * configuración del tenant e imprime la URL exacta que el sync le mandaría al
 * Service Layer, más el estado de cada compuerta que puede hacer que
 * invoice.handler devuelva 'skipped' en silencio.
 *
 * Uso:
 *   node scripts/diagnose-invoice-sync.mjs <tenantKey> [dealId]
 *
 * Ejemplo:
 *   node scripts/diagnose-invoice-sync.mjs sap_integration_printer 60275617685
 */
import 'dotenv/config';
import { getTenantModels, disconnectTenantConnections } from '#infrastructure/database/tenant/tenantDatabase.js';
import { buildServiceLayerUrl } from '#infrastructure/sap/serviceLayerUrlBuilder.js';
import { buildSapFetchOptions } from '#application/services/sap-sync-options.service.js';
import { getUpdateDealStageConfig } from '#infrastructure/config/updateDealStage.config.js';

const tenantKey = process.argv[2];
const dealId = process.argv[3] ?? null;

if (!tenantKey) {
  console.error('Falta el tenantKey. Uso: node scripts/diagnose-invoice-sync.mjs <tenantKey> [dealId]');
  process.exit(1);
}

function line(title) {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  const models = await getTenantModels(tenantKey);
  const {
    ClientConfig, Configuration, SapDocumentLink, SyncLog, FieldMapping,
  } = models;

  line('0. Reloj del proceso');
  const now = new Date();
  console.log('Hora local del proceso :', now.toString());
  console.log('Hora UTC               :', now.toISOString());
  console.log('Zona horaria detectada :', Intl.DateTimeFormat().resolvedOptions().timeZone);
  console.log('process.env.TZ         :', process.env.TZ ?? '(sin definir)');
  console.log('NOTA: los filtros dinámicos UpdateDate/UpdateTime se calculan con esta hora local.');

  line('1. ClientConfig de invoice');
  const config = await ClientConfig.findOne({ objectType: 'invoice' })
    .populate({ path: 'integrationModeId', select: 'name' })
    .lean();

  if (!config) {
    console.log('NO existe un ClientConfig con objectType "invoice" en este tenant. El sync nunca corre.');
    return;
  }

  console.log({
    _id: String(config._id),
    active: config.active,
    mode: config.mode,
    taskType: config.taskType,
    intervalMinutes: config.intervalMinutes,
    integrationMode: config.integrationModeId?.name,
    serviceLayerPath: config.serviceLayerPath,
    hubspotCredentialId: String(config.hubspotCredentialId ?? null),
    filtros: config.filters,
  });

  line('2. FieldMappings de invoice (los que arman el $select)');
  const mappings = await FieldMapping.find({
    objectType: 'invoice',
    hubspotCredentialId: config.hubspotCredentialId,
  }).lean();
  console.table(mappings.map((m) => ({
    sourceField: m.sourceField,
    targetField: m.targetField,
    sourceContext: m.sourceContext,
    active: m.active,
    enSelect: m.includeInServiceLayerSelect !== false,
  })));
  const traeNumAtCard = mappings.some(
    (m) => m.sourceField === 'NumAtCard' && m.includeInServiceLayerSelect !== false
  );
  console.log(traeNumAtCard
    ? 'OK: NumAtCard viaja en el $select.'
    : 'PROBLEMA: NumAtCard NO llega en el $select -> el handler nunca puede extraer el dealId.');

  line('3. URL exacta que se le pediría al Service Layer AHORA');
  try {
    const fetchOptions = buildSapFetchOptions(config, () => now);
    console.log('fetchOptions:', fetchOptions);
    // El runtime fusiona SapCredentials sobre la ClientConfig antes de armar la
    // URL (SapSyncDataAdapter.fetchServiceLayerData), y de ahí sale el
    // serviceLayerBaseUrl. Sin esa fusión el builder falla por una razón que no
    // existe en producción.
    const [sapCredentials] = await models.SapCredentials.find().lean();
    if (!sapCredentials) {
      console.log('PROBLEMA: no hay SapCredentials en el tenant; el modo SERVICE_LAYER falla.');
    }
    const url = buildServiceLayerUrl(
      { ...sapCredentials, ...config, integrationModeName: config.integrationModeId?.name },
      mappings,
      fetchOptions
    );
    console.log(url);
    console.log('\n$filter decodificado:');
    const raw = new URL(url).searchParams.get('$filter');
    console.log(raw ?? '(sin filtro)');
  } catch (error) {
    console.log('La construcción de la URL FALLA:', error.message);
  }

  line('4. Configuración updateDealStage');
  const updateDealStage = await getUpdateDealStageConfig({ tenantModels: models });
  console.log(updateDealStage);
  const rawConfig = await Configuration.findOne({ key: 'updateDealStage' }).lean();
  console.log('Documento crudo en Configurations:', rawConfig ?? '(no existe)');
  if (!updateDealStage.isRequired || !updateDealStage.dealstage) {
    console.log('PROBLEMA: con isRequired=false o dealstage vacío el handler siempre devuelve "skipped".');
  }

  line('5. SapDocumentLinks tipo "order"');
  const totalOrders = await SapDocumentLink.countDocuments({ documentType: 'order' });
  console.log('Total de links de orden en el tenant:', totalOrders);

  if (dealId) {
    const anyLink = await SapDocumentLink.find({ dealId: String(dealId) }).lean();
    console.log(`Links para el deal ${dealId}:`, anyLink.map((l) => ({
      documentType: l.documentType,
      sapDocEntry: l.sapDocEntry,
      sapDocNum: l.sapDocNum,
      hubspotCredentialId: String(l.hubspotCredentialId),
    })));

    const match = await SapDocumentLink.findOne({
      hubspotCredentialId: config.hubspotCredentialId,
      dealId: String(dealId),
      documentType: 'order',
    }).lean();
    console.log(match
      ? 'OK: el handler SÍ encuentra el link de la orden para este deal.'
      : 'PROBLEMA: el handler NO encuentra link (documentType "order" + el hubspotCredentialId de la config de invoice).');
  } else {
    console.log('Pasá un dealId como segundo argumento para verificar el link de un negocio concreto.');
  }

  line('6. Últimos SyncLogs de la config de invoice');
  const logs = await SyncLog.find({ clientConfigId: config._id })
    .sort({ startedAt: -1 })
    .limit(5)
    .lean();
  console.table(logs.map((l) => ({
    startedAt: l.startedAt,
    status: l.status,
    recordsProcessed: l.recordsProcessed,
    sent: l.sent,
    failed: l.failed,
    error: typeof l.errorMessage === 'string' ? l.errorMessage : JSON.stringify(l.errorMessage),
  })));
  console.log('Lectura: recordsProcessed=0 -> SAP no devolvió la factura (filtro/entidad/hora).');
  console.log('         recordsProcessed>0 y status=completed -> SAP sí trajo facturas y se cayó');
  console.log('         en una compuerta del handler. OJO: el modelo SyncLog no guarda "updated",');
  console.log('         y un "skipped" del handler se cuenta como "sent", así que este log NO');
  console.log('         distingue entre "movió el negocio" y "no hizo nada".');
}

main()
  .catch((error) => {
    console.error('Falló el diagnóstico:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectTenantConnections();
    process.exit(process.exitCode ?? 0);
  });
