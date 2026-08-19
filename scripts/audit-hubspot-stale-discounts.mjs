/**
 * Auditoría de SOLO LECTURA: qué productos (y opcionalmente line items) tienen
 * un descuento cargado en HubSpot.
 *
 * Sirve para medir el arrastre del bug viejo (la tasa de impuesto escrita como
 * descuento) antes de decidir cómo limpiarlo. NO escribe en HubSpot y NO escribe
 * en Mongo, con una excepción conocida: si el access token del tenant ya vencio,
 * hubspotAuthService lo renueva y persiste el nuevo, que es lo que hace cualquier
 * sync normal.
 *
 * Uso:
 *   node scripts/audit-hubspot-stale-discounts.mjs <tenantKey> [--line-items]
 *
 * Ejemplo:
 *   node scripts/audit-hubspot-stale-discounts.mjs sap_integration_noelito
 */
import 'dotenv/config';
import { getTenantModels, disconnectTenantConnections } from '#infrastructure/database/tenant/tenantDatabase.js';
import hubspotAuthService from '#infrastructure/hubspot/hubspotAuthService.js';
import { hubspotGet, hubspotPost } from '#infrastructure/hubspot/hubspotClient.js';

const tenantKey = process.argv[2];
const includeLineItems = process.argv.includes('--line-items');

if (!tenantKey) {
  console.error('Uso: node scripts/audit-hubspot-stale-discounts.mjs <tenantKey> [--line-items]');
  process.exit(1);
}

function line(title) {
  console.log(`\n=== ${title} ===`);
}

// El search de HubSpot es 5/s a nivel de cuenta: paginado secuencial y con freno.
async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function searchAllWithProperty(token, objectType, propertyName, properties) {
  const results = [];
  let after;

  do {
    const payload = {
      filterGroups: [{ filters: [{ propertyName, operator: 'HAS_PROPERTY' }] }],
      properties,
      limit: 100,
      ...(after ? { after } : {}),
    };

    const response = await hubspotPost(token, `/crm/v3/objects/${objectType}/search`, payload);
    if (Array.isArray(response?.results)) {
      results.push(...response.results);
    }
    after = response?.paging?.next?.after;
    if (after) await sleep(250);
  } while (after);

  return results;
}

// listAllObjects del cliente solo soporta company/contact, asi que el listado
// paginado de products / line_items va aca.
async function listAll(token, objectType, properties) {
  const records = [];
  let after;

  do {
    const response = await hubspotGet(token, `/crm/v3/objects/${objectType}`, {
      properties: properties.join(','),
      limit: 100,
      ...(after ? { after } : {}),
    });
    if (Array.isArray(response?.results)) {
      records.push(...response.results);
    }
    after = response?.paging?.next?.after;
  } while (after);

  return records;
}

function isMeaningful(value) {
  if (value === null || value === undefined || String(value).trim() === '') return false;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric !== 0 : true;
}

async function auditObjectType(token, objectType, discountProperties, identityProperties) {
  line(`Descuentos cargados en ${objectType}`);

  // Listado completo por GET en vez de search: el search de products devuelve 400
  // sobre `discount` (propiedad no filtrable), y asi de paso queda el total real
  // de registros como denominador.
  const allRecords = await listAll(token, objectType, [...identityProperties, ...discountProperties]);
  console.log(`Total de ${objectType} en el portal: ${allRecords.length}`);

  for (const propertyName of discountProperties) {
    const records = allRecords.filter((record) => {
      const value = record?.properties?.[propertyName];
      return value !== null && value !== undefined && String(value).trim() !== '';
    });

    const withValue = records.filter((record) => isMeaningful(record?.properties?.[propertyName]));
    console.log(`\n  --- ${propertyName}: ${records.length} con la propiedad presente, ${withValue.length} con valor distinto de 0/vacio ---`);

    if (withValue.length === 0) continue;

    const byValue = new Map();
    withValue.forEach((record) => {
      const value = String(record.properties[propertyName]);
      byValue.set(value, (byValue.get(value) ?? 0) + 1);
    });
    console.log('  Reparto por valor:', JSON.stringify(Object.fromEntries(byValue)));

    console.log('  Registros:');
    withValue.forEach((record) => {
      const identity = identityProperties
        .map((key) => `${key}=${record.properties?.[key] ?? ''}`)
        .join(' | ');
      console.log(`    id=${record.id} | ${identity} | ${propertyName}=${record.properties[propertyName]}`);
    });
  }
}

async function main() {
  const models = await getTenantModels(tenantKey);
  const { HubspotCredentials, ClientConfig, Configuration } = models;

  line('0. Credenciales del tenant');
  const credentials = await HubspotCredentials.findOne().lean();
  if (!credentials) {
    console.log('Sin credenciales de HubSpot para este tenant. Fin.');
    return;
  }
  console.log('portalId  :', credentials.portalId);
  console.log('expiresAt :', credentials.expiresAt);

  const clientConfig = await ClientConfig.findById(credentials.clientConfigId).lean();
  console.log('clientConfig:', clientConfig?.name ?? clientConfig?._id ?? '(no encontrado)');

  const discountDoc = await Configuration.findOne({ key: 'requireDiscounts' }).lean();
  const configuredDiscountField = discountDoc?.value?.fieldMappings?.Discount ?? null;
  console.log('requireDiscounts.fieldMappings.Discount:', configuredDiscountField ?? '(sin definir)');

  const token = await hubspotAuthService.getAccessToken(
    credentials.clientConfigId,
    credentials,
    models
  );

  line('1. Propiedades de descuento que EXISTEN en products');
  const productProperties = await hubspotGet(token, '/crm/v3/properties/products');
  const productDiscountProperties = (productProperties?.results ?? [])
    .filter((property) => /discount/i.test(property.name))
    .map((property) => property.name);
  console.log(productDiscountProperties.length > 0
    ? productDiscountProperties.join(', ')
    : '(ninguna propiedad con "discount" en el nombre)');
  if (configuredDiscountField && !productDiscountProperties.includes(configuredDiscountField)) {
    console.log(`>>> OJO: ${configuredDiscountField} NO existe como propiedad de products en este portal.`);
  }

  if (productDiscountProperties.length > 0) {
    await auditObjectType(token, 'products', productDiscountProperties, ['hs_sku', 'name']);
  }

  if (!includeLineItems) {
    console.log('\n(Para auditar tambien los line items, agrega --line-items)');
    return;
  }

  line('2. Propiedades de descuento que EXISTEN en line_items');
  const lineItemProperties = await hubspotGet(token, '/crm/v3/properties/line_items');
  const lineItemDiscountProperties = (lineItemProperties?.results ?? [])
    .filter((property) => /discount/i.test(property.name))
    .map((property) => property.name);
  console.log(lineItemDiscountProperties.join(', ') || '(ninguna)');

  if (lineItemDiscountProperties.length > 0) {
    await auditObjectType(token, 'line_items', lineItemDiscountProperties, ['hs_sku', 'name', 'hs_object_id']);
  }
}

main()
  .catch((error) => {
    console.error('\nFALLO:', error?.details?.status ?? '', error?.details?.data ?? error.message);
    process.exitCode = 1;
  })
  .finally(async () => { await disconnectTenantConnections(); });
