/**
 * Diagnóstico del descuento que el conector le pone a un item.
 *
 * NO escribe en Mongo y NO escribe en HubSpot. De SAP sólo lee; la única llamada
 * POST es a CompanyService_GetItemPrice, que es la simulación de precio del
 * Service Layer (no persiste nada, es la misma que el conector usa para leer).
 *
 * Uso:
 *   node scripts/diagnose-discount.mjs <tenantKey> <itemCode> [cardCode]
 *
 * Ejemplo:
 *   node scripts/diagnose-discount.mjs sap_integration_noelito P45020002 CL999999
 */
import 'dotenv/config';
import axios from 'axios';
import https from 'https';
import { getTenantModels, disconnectTenantConnections } from '#infrastructure/database/tenant/tenantDatabase.js';
import sapSessionManager from '#infrastructure/sap/sapSessionManager.js';
import { paginateODataCollection } from '#infrastructure/sap/transport/B1ServiceLayerTransport.js';
import { resolveDiscount } from '#domain/products/discount-resolver.service.js';

// Igual que todos los adaptadores SAP del proyecto: el Service Layer usa un cert
// cuyo altname no coincide con la IP.
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const tenantKey = process.argv[2];
const itemCode = process.argv[3];
const cardCode = process.argv[4] ?? null;

if (!tenantKey || !itemCode) {
  console.error('Uso: node scripts/diagnose-discount.mjs <tenantKey> <itemCode> [cardCode]');
  process.exit(1);
}

function line(title) {
  console.log(`\n=== ${title} ===`);
}

function dayTs(value, edge) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return NaN;
  return edge === 'end'
    ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999)
    : Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0);
}

async function sapGet(url, headers, label) {
  console.log('GET', url);
  try {
    const { data } = await axios.get(url, { headers, httpsAgent, timeout: 30000 });
    return data;
  } catch (error) {
    const detail = JSON.stringify(error?.response?.data ?? error.message);
    console.log(`ERROR ${label}:`, error?.response?.status ?? '', detail.slice(0, 500));
    return null;
  }
}

async function main() {
  const models = await getTenantModels(tenantKey);
  const { SapCredentials, Configuration, FieldMapping } = models;

  line('0. Reloj del proceso');
  const now = new Date();
  console.log('Hora local :', now.toString());
  console.log('Hora UTC   :', now.toISOString());
  console.log('TZ         :', Intl.DateTimeFormat().resolvedOptions().timeZone, '| process.env.TZ:', process.env.TZ ?? '(sin definir)');

  line('1. Configuracion requireDiscounts');
  // Lectura directa: tenantConfigurationService.getValue hace upsert cuando la
  // clave no existe, y este script no debe escribir nada.
  const discountDoc = await Configuration.findOne({ key: 'requireDiscounts' }).lean();
  console.log(discountDoc ? JSON.stringify(discountDoc.value, null, 2) : '(la clave requireDiscounts no existe)');
  const configuredDiscountField = discountDoc?.value?.fieldMappings?.Discount ?? null;

  line('2. FieldMappings que apuntan a una propiedad de descuento');
  // Sospechoso principal: si un FieldMapping escribe la propiedad de descuento
  // directamente desde un campo de SAP, mapRecords la escribe sin pasar por
  // resolveDiscount.
  const discountMappings = await FieldMapping.find({
    $or: [
      { targetField: /discount/i },
      { sourceField: /discount/i },
    ],
  }).lean();
  if (discountMappings.length === 0) {
    console.log('Ninguno. (Buscado por targetField o sourceField que contenga "discount")');
  } else {
    discountMappings.forEach((mapping) => {
      console.log('---');
      console.log('  objectType    :', mapping.objectType);
      console.log('  sourceContext :', mapping.sourceContext);
      console.log('  sourceField   :', mapping.sourceField);
      console.log('  targetField   :', mapping.targetField);
      console.log('  isActive      :', mapping.isActive);
      console.log('  includeInServiceLayerSelect:', mapping.includeInServiceLayerSelect ?? null);
      if (configuredDiscountField && mapping.targetField === configuredDiscountField) {
        console.log('  >>> CHOCA con requireDiscounts.fieldMappings.Discount:', configuredDiscountField);
      }
    });
  }

  line('2b. Codigos de impuesto (taxCodes) y sus tasas');
  // El bloque comentado en SyncLineItemPrices usaba resolveTaxRate, que devolvia
  // la TASA DE IMPUESTO como descuento. Si algun Rate vale 10, ese 10 es la
  // huella de esa ruta y no de un descuento real de SAP.
  const taxDoc = await Configuration.findOne({ key: 'taxCodes' }).lean();
  if (!taxDoc) {
    console.log('(la clave taxCodes no existe)');
  } else {
    console.log('FieldItem:', taxDoc.FieldItem ?? '(sin definir)');
    const taxCodes = Array.isArray(taxDoc.value) ? taxDoc.value : [];
    taxCodes.forEach((taxCode) => {
      const flag = Number(taxCode?.Rate) === 10 ? '   <<< TASA 10' : '';
      console.log(`  Code=${taxCode?.Code} Rate=${taxCode?.Rate} HSCode=${taxCode?.HSCode}${flag}`);
    });
    if (taxCodes.some((taxCode) => Number(taxCode?.Rate) === 10)) {
      console.log('\n>>> Hay un codigo de impuesto con tasa 10: el 10 reportado calza con');
      console.log('    resolveTaxRate (tasa de impuesto usada como descuento), NO con un');
      console.log('    descuento de EnhancedDiscountGroups.');
    }
  }

  const [sapConfig] = await SapCredentials.find().lean();
  if (!sapConfig) {
    console.log('\nSin credenciales SAP para este tenant. Fin.');
    return;
  }

  const baseUrl = String(sapConfig.serviceLayerBaseUrl || '').trim().replace(/\/+$/, '');
  const { cookie } = await sapSessionManager.getSessionCookie(sapConfig);
  const headers = { Cookie: cookie, Prefer: 'odata.maxpagesize=100' };

  line('3. El item en SAP');
  const itemData = await sapGet(
    `${baseUrl}/b1s/v2/Items('${itemCode}')?$select=ItemCode,ItemName,ItemsGroupCode`,
    headers,
    'leyendo el item'
  );
  const itemsGroupCode = itemData?.ItemsGroupCode ?? null;
  if (itemData) {
    console.log(JSON.stringify(itemData, null, 2));
  }

  line('4. EnhancedDiscountGroups activos (payload REAL, sin $select)');
  const { items: groups } = await paginateODataCollection({
    rootUrl: baseUrl,
    initialUrl: `${baseUrl}/b1s/v2/EnhancedDiscountGroups?$filter=${encodeURIComponent("Active eq 'tYES'")}`,
    headers,
    timeout: 30000,
  });
  console.log('Grupos activos:', groups.length);
  const nowTs = Date.now();
  let matches = 0;
  for (const group of groups) {
    const lines = Array.isArray(group?.DiscountGroupLineCollection) ? group.DiscountGroupLineCollection : [];
    const hits = lines.filter((l) => (
      (l?.ObjectType === 'dgboItems' && String(l?.ObjectCode ?? '').trim() === itemCode)
      || (l?.ObjectType === 'dgboItemGroups' && itemsGroupCode !== null && String(l?.ObjectCode ?? '').trim() === String(itemsGroupCode))
    ));
    const from = dayTs(group?.ValidFrom, 'start');
    const to = dayTs(group?.ValidTo, 'end');
    const vigente = !Number.isNaN(from) && !Number.isNaN(to)
      && (from === null || nowTs >= from) && (to === null || nowTs <= to);
    console.log(`\n--- AbsEntry ${group?.AbsEntry} | Type=${group?.Type} ObjectCode=${group?.ObjectCode} | ${group?.ValidFrom ?? '(vacio)'} -> ${group?.ValidTo ?? '(vacio)'} | lineas=${lines.length} ---`);
    console.log('  Vigente hoy?:', vigente, from === null ? '(ValidFrom vacio = abierto)' : '', to === null ? '(ValidTo vacio = abierto)' : '');
    if (hits.length > 0) {
      matches += 1;
      console.log('  LINEAS QUE APLICAN A ESTE ITEM:', JSON.stringify(hits));
    }
  }
  if (matches === 0) {
    console.log('\n>>> Ningun grupo activo tiene linea para este item ni para su grupo de items.');
  }

  line('5. Lo que devuelve resolveDiscount con el payload real');
  const resolved = resolveDiscount(groups, { itemCode, itemsGroupCode, currentDate: new Date() });
  console.log('itemCode:', itemCode, '| itemsGroupCode:', itemsGroupCode);
  console.log('DESCUENTO RESUELTO:', resolved === null ? 'null (esta ruta no escribe nada)' : resolved);

  line('6. SpecialPrices (precios especiales por cliente) para este item');
  const specialFilter = cardCode
    ? `ItemCode eq '${itemCode}' and CardCode eq '${cardCode}'`
    : `ItemCode eq '${itemCode}'`;
  const special = await sapGet(
    `${baseUrl}/b1s/v2/SpecialPrices?$filter=${encodeURIComponent(specialFilter)}`,
    headers,
    'leyendo SpecialPrices'
  );
  if (special) {
    const rows = special?.value ?? [];
    console.log('Filas:', rows.length);
    console.log(JSON.stringify(rows, null, 2).slice(0, 3000));
  }

  line('7. CompanyService_GetItemPrice: el precio y descuento que SAP calcula');
  if (!cardCode) {
    console.log('(omitido: hace falta el cardCode)');
  } else {
    const payload = {
      ItemPriceParams: {
        ItemCode: itemCode,
        CardCode: cardCode,
        Date: new Date().toISOString().slice(0, 10),
      },
    };
    console.log('POST', `${baseUrl}/b1s/v2/CompanyService_GetItemPrice`);
    console.log('Body:', JSON.stringify(payload));
    try {
      const { data } = await axios.post(
        `${baseUrl}/b1s/v2/CompanyService_GetItemPrice`,
        payload,
        { headers: { Cookie: cookie }, httpsAgent, timeout: 30000 }
      );
      console.log(JSON.stringify(data, null, 2));
      console.log('\n>>> Discount que SAP calcula para este cliente+item:', data?.Discount ?? '(sin campo Discount)');
    } catch (error) {
      const detail = JSON.stringify(error?.response?.data ?? error.message);
      console.log('ERROR GetItemPrice:', error?.response?.status ?? '', detail.slice(0, 800));
    }
  }
}

main()
  .catch((error) => {
    console.error('\nFALLO:', error?.response?.status ?? '', error?.response?.data ?? error.message);
    process.exitCode = 1;
  })
  .finally(async () => { await disconnectTenantConnections(); });
