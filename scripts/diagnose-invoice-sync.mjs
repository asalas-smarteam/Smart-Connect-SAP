/**
 * Diagnóstico SOLO LECTURA del flujo factura SAP -> etapa del negocio en HubSpot.
 *
 * No escribe en Mongo, no llama a HubSpot y no llama a SAP: solo lee la
 * configuración del tenant e imprime la URL exacta que el sync le mandaría al
 * Service Layer, más el estado de cada compuerta que puede hacer que
 * invoice.handler devuelva 'skipped' en silencio.
 *
 * La reconciliación (desde 2026-08-19) sigue el linaje de SAP: factura ->
 * DocumentLines[].BaseEntry (BaseType 17) -> SapDocumentLink de la orden -> dealId.
 * El NumAtCard ya no decide nada, solo viaja al log.
 *
 * Uso:
 *   node scripts/diagnose-invoice-sync.mjs <tenantKey> [orderDocEntry] [dealId]
 *
 * orderDocEntry es el DocEntry de la orden (DocumentLines[].BaseEntry de una factura real)
 * y es lo que el handler usa para buscar el link. dealId es solo informativo: lista todos
 * los SapDocumentLinks (de cualquier documentType) que tiene ese negocio.
 *
 * Ejemplo:
 *   node scripts/diagnose-invoice-sync.mjs sap_integration_printer 28987 60275617685
 */
import 'dotenv/config';
import { getTenantModels, disconnectTenantConnections } from '#infrastructure/database/tenant/tenantDatabase.js';
import { buildServiceLayerUrl } from '#infrastructure/sap/serviceLayerUrlBuilder.js';
import { buildSapFetchOptions } from '#application/services/sap-sync-options.service.js';
import { getUpdateDealStageConfig } from '#infrastructure/config/updateDealStage.config.js';

const tenantKey = process.argv[2];
const orderDocEntryArg = process.argv[3] ?? null;
const orderDocEntry = orderDocEntryArg !== null && orderDocEntryArg !== '' ? Number(orderDocEntryArg) : null;
const dealId = process.argv[4] ?? null;

if (!tenantKey) {
  console.error(
    'Falta el tenantKey. Uso: node scripts/diagnose-invoice-sync.mjs <tenantKey> [orderDocEntry] [dealId]'
  );
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
  // DocumentLines es requerido por diseño (serviceLayerUrlBuilder.js) y no depende de ningún
  // mapping: es lo que el handler usa para leer BaseEntry/BaseType y reconciliar la orden. Sin
  // él en la respuesta de SAP, el handler descarta TODA factura en NO_ORDER_BASE_ENTRY. NumAtCard
  // ya no decide nada: solo viaja al log de la corrida exitosa.
  const activeMappings = mappings.filter((m) => m.active !== false);
  console.log(activeMappings.length > 0
    ? `OK: hay ${activeMappings.length} mapping(s) activo(s) de invoice.`
    : 'PROBLEMA: no hay ningun mapping activo de invoice -> buildServiceLayerUrl revienta '
      + '("At least one active mapping with a valid sourceField is required").');

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

    const select = new URL(url).searchParams.get('$select') ?? '';
    const traeDocumentLines = select.split(',').includes('DocumentLines');
    console.log(traeDocumentLines
      ? 'OK: DocumentLines viaja en el $select (requerido para reconciliar por linaje).'
      : 'PROBLEMA: DocumentLines NO llega en el $select -> el handler no puede leer BaseEntry '
        + 'ni BaseType y descarta TODA factura en NO_ORDER_BASE_ENTRY. Esto solo puede pasar si '
        + 'la config no está en modo SERVICE_LAYER, único modo donde este builder corre.');
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

  // Esta es la búsqueda real que hace el handler (findByOrderDocEntry): por el DocEntry de la
  // orden que la factura trae en DocumentLines[].BaseEntry, no por dealId.
  if (Number.isInteger(orderDocEntry)) {
    const match = await SapDocumentLink.findOne({
      hubspotCredentialId: config.hubspotCredentialId,
      documentType: 'order',
      sapDocEntry: orderDocEntry,
    }).lean();
    console.log(match
      ? `OK: el handler SÍ encuentra el link de la orden ${orderDocEntry} (dealId ${match.dealId}).`
      : `PROBLEMA: el handler NO encuentra link para sapDocEntry ${orderDocEntry} `
        + '(documentType "order" + el hubspotCredentialId de la config de invoice). '
        + 'Puede ser un pedido que la integración no creó (normal) o un DocEntry equivocado.');
  } else {
    console.log(
      'Pasá el DocEntry de una orden (DocumentLines[].BaseEntry de una factura real, '
      + 'BaseType 17) como segundo argumento para verificar el link exacto que usa el handler.'
    );
  }

  if (dealId) {
    // Informativo: lista todos los links de este negocio sin importar documentType. No es la
    // búsqueda que hace el handler (esa es por sapDocEntry, arriba), pero sirve para ver qué
    // documentos de SAP quedaron asociados a este deal.
    const anyLink = await SapDocumentLink.find({ dealId: String(dealId) }).lean();
    console.log(`Links para el deal ${dealId} (informativo, no es la búsqueda del handler):`,
      anyLink.map((l) => ({
        documentType: l.documentType,
        sapDocEntry: l.sapDocEntry,
        sapDocNum: l.sapDocNum,
        hubspotCredentialId: String(l.hubspotCredentialId),
      })));
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
    updated: l.updated,
    skipped: l.skipped,
    failed: l.failed,
    error: typeof l.errorMessage === 'string' ? l.errorMessage : JSON.stringify(l.errorMessage),
  })));
  console.log('skippedReasons del último log:', logs[0]?.skippedReasons ?? '(sin logs)');
  console.log('Lectura: recordsProcessed=0 -> SAP no devolvió la factura (filtro/entidad/hora).');
  console.log('         recordsProcessed>0 y status=completed -> SAP sí trajo facturas y se cayó');
  console.log('         en una compuerta del handler. Un "skipped" del handler YA NO se cuenta');
  console.log('         como "sent" (corregido): el SyncLog trae los campos "updated", "skipped"');
  console.log('         y "skippedReasons" además de "sent"/"failed". OJO: "updated" cuenta');
  console.log('         FACTURAS con al menos un negocio movido, no negocios (una factura');
  console.log('         consolidada que mueve 3 negocios suma 1 igual). Mirá "skippedReasons" en');
  console.log('         el documento crudo del SyncLog para el desglose por motivo');
  console.log('         (no_order_base_entry, order_link_not_found, update_deal_stage_disabled).');
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
