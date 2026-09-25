// scripts/verify-s4-sales-quotation.mjs
//
// Verificación en vivo de los supuestos del spec 2026-09-14-s4-create-quotation-design.md.
// No escribe nada en SAP salvo en el paso 3, que está apagado por defecto: correrlo con
// CREATE=1 solo cuando se quiera intentar el POST de prueba.
//
//   node scripts/verify-s4-sales-quotation.mjs
//   CREATE=1 SOLD_TO=100053 MATERIAL=1001 node scripts/verify-s4-sales-quotation.mjs
import { MongoClient } from 'mongodb';
import axios from 'axios';
import https from 'https';

const MONGO_URI = process.env.LOCAL_MONGO_URI || 'mongodb://localhost:27017';
const TENANT_DB = process.env.TENANT_DB || 'sap_integration_multiquimica';
const agent = new https.Agent({ rejectUnauthorized: false });

async function loadCredentials() {
  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const credentials = await client.db(TENANT_DB).collection('SapCredentials').findOne({});
  await client.close();

  if (!credentials?.serviceLayerBaseUrl) {
    throw new Error(`Sin SapCredentials en ${TENANT_DB}`);
  }

  return {
    base: String(credentials.serviceLayerBaseUrl).replace(/\/+$/, ''),
    auth: {
      username: credentials.serviceLayerUsername,
      password: credentials.serviceLayerPassword,
    },
  };
}

async function get({ base, auth }, path, params = {}) {
  try {
    const response = await axios.get(`${base}${path}`, {
      auth, httpsAgent: agent, timeout: 40000, params: { $format: 'json', ...params },
    });
    return { status: response.status, data: response.data, headers: response.headers };
  } catch (error) {
    return { status: error?.response?.status ?? 'ERR', data: error?.response?.data ?? error.message };
  }
}

// El gateway exige token CSRF + su cookie para cualquier escritura. Se piden contra el
// documento de servicio, igual que hace S4GatewayTransport.
async function fetchCsrf({ base, auth }, servicePath) {
  const response = await axios.get(`${base}${servicePath}/`, {
    auth, httpsAgent: agent, timeout: 40000, headers: { 'x-csrf-token': 'Fetch' },
  });
  return {
    token: response.headers['x-csrf-token'],
    cookie: (response.headers['set-cookie'] || []).map((c) => String(c).split(';')[0]).join('; '),
  };
}

const QUOTATION_SERVICE = '/sap/opu/odata/sap/API_SALES_QUOTATION_SRV';

async function main() {
  const creds = await loadCredentials();
  console.log('Base:', creds.base, '\n');

  // 1. ¿El servicio de ofertas está activado?
  const metadata = await get(creds, `${QUOTATION_SERVICE}/$metadata`);
  console.log('1) API_SALES_QUOTATION_SRV $metadata =>', metadata.status);

  if (metadata.status === 403) {
    // Este sistema registra las activaciones con ID prefijado Z; el Title trae el nombre real.
    const catalog = await get(
      creds,
      '/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/ServiceCollection',
      { $select: 'ID,Title', $top: 2000 }
    );
    const rows = catalog.data?.d?.results ?? [];
    const matches = rows.filter((row) => /QUOTATION|SALES_ORDER/i.test(`${row.ID} ${row.Title}`));
    console.log('   Candidatos en el catálogo:', JSON.stringify(matches, null, 1));
  }

  // 2. Nombres reales de campo, de una oferta existente con sus posiciones e interlocutores.
  const sample = await get(creds, `${QUOTATION_SERVICE}/A_SalesQuotation`, {
    $top: 1, $expand: 'to_Item,to_Partner',
  });
  console.log('2) Oferta de muestra =>', sample.status);
  const first = sample.data?.d?.results?.[0];
  if (first) {
    console.log('   Campos de cabecera:', Object.keys(first).sort().join(', '));
    console.log('   Campos de posición:', Object.keys(first.to_Item?.results?.[0] ?? {}).sort().join(', '));
    console.log('   Interlocutores:', JSON.stringify(first.to_Partner?.results ?? [], null, 1));
  }

  // 3. ¿El deep create con to_Item pasa? Apagado salvo CREATE=1.
  if (process.env.CREATE === '1') {
    const { token, cookie } = await fetchCsrf(creds, QUOTATION_SERVICE);
    const body = {
      SalesQuotationType: process.env.QUOTATION_TYPE,
      SalesOrganization: process.env.SALES_ORG,
      DistributionChannel: process.env.DISTRIBUTION_CHANNEL,
      OrganizationDivision: process.env.DIVISION,
      SoldToParty: process.env.SOLD_TO,
      to_Item: [{
        SalesQuotationItem: '000010',
        Material: process.env.MATERIAL,
        RequestedQuantity: '1',
      }],
    };
    console.log('3) POST de prueba:', JSON.stringify(body));
    try {
      const created = await axios.post(`${creds.base}${QUOTATION_SERVICE}/A_SalesQuotation`, body, {
        auth: creds.auth, httpsAgent: agent, timeout: 60000,
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': token, Cookie: cookie },
      });
      console.log('   OK =>', created.status, JSON.stringify(created.data?.d ?? created.data).slice(0, 500));
    } catch (error) {
      console.log('   FALLÓ =>', error?.response?.status, JSON.stringify(error?.response?.data ?? error.message).slice(0, 1500));
    }
  } else {
    console.log('3) POST de prueba omitido (correr con CREATE=1 para intentarlo)');
  }

  // 4. ¿Se puede crear un BusinessPartner con to_Customer? Solo se lee el $metadata para ver
  //    si la navegación to_Customer es creatable; el POST real se intenta a mano después.
  const bpMetadata = await get(creds, '/sap/opu/odata/sap/API_BUSINESS_PARTNER/$metadata');
  console.log('4) API_BUSINESS_PARTNER $metadata =>', bpMetadata.status);

  // 5. Muestra de cliente con su área de ventas, para leer los valores reales de
  //    SalesOrganization / DistributionChannel / Division / PriceListType del sistema.
  const customer = await get(creds, '/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_CustomerSalesArea', { $top: 5 });
  console.log('5) Áreas de venta de muestra =>', customer.status);
  console.log('  ', JSON.stringify(customer.data?.d?.results ?? [], null, 1).slice(0, 1200));
}

main().catch((error) => {
  console.error('FALLÓ:', error.message);
  process.exitCode = 1;
});
