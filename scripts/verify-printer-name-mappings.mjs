import 'dotenv/config';
import mongoose from 'mongoose';

const conn = await mongoose.createConnection(process.env.MONGODB_URI, { dbName: 'sap_integration_printer' }).asPromise();
const fm = conn.db.collection('FieldMappings');

const rows = await fm.find({
  $or: [
    { objectType: 'contact', sourceContext: 'contactEmployee' },
    { objectType: 'contact', sourceContext: 'businessPartner', sourceField: 'CardName' },
    { objectType: 'deal', sourceContext: 'orders-quotations', sourceField: { $in: ['U_TIPOCON', 'DocumentsOwner'] } },
  ],
}).sort({ _id: 1 }).toArray();

console.log('--- filas relevantes (orden _id asc) ---');
rows.forEach((r) => console.log(
  `${r.objectType}|${r.sourceContext}  SAP=${r.sourceField}  <- HS=${r.targetField}  active=${r.isActive}  _id=${r._id}`
));

const check = (label, ok, detalle) => console.log(`${ok ? 'OK  ' : 'MAL '} ${label}${detalle ? ' :: ' + detalle : ''}`);
const find = (ot, sc, sf) => rows.find((r) => r.objectType === ot && r.sourceContext === sc && r.sourceField === sf);

console.log('\n--- verificacion ---');
const name = find('contact', 'contactEmployee', 'Name');
const cardName = find('contact', 'businessPartner', 'CardName');
const first = find('contact', 'contactEmployee', 'FirstName');
const middle = find('contact', 'contactEmployee', 'MiddleName');
const last = find('contact', 'contactEmployee', 'LastName');
const suc = find('contact', 'contactEmployee', 'U_SUCURSAL');
const tipocon = find('deal', 'orders-quotations', 'U_TIPOCON');

check('Name -> nombre_completo', name?.targetField === 'nombre_completo' && name?.isActive !== false, name ? `hoy="${name.targetField}"` : 'FILA AUSENTE');
check('CardName -> nombre_completo', cardName?.targetField === 'nombre_completo' && cardName?.isActive !== false, cardName ? `hoy="${cardName.targetField}"` : 'FILA AUSENTE');
check('FirstName -> firstname', first?.targetField === 'firstname' && first?.isActive !== false, first ? `hoy="${first.targetField}"` : 'FILA AUSENTE');
check('MiddleName -> middlename', middle?.targetField === 'middlename' && middle?.isActive !== false, middle ? `hoy="${middle.targetField}"` : 'FILA AUSENTE');
check('LastName -> lastname', last?.targetField === 'lastname' && last?.isActive !== false, last ? `hoy="${last.targetField}"` : 'FILA AUSENTE');
check('U_SUCURSAL -> u_sucursal', suc?.targetField === 'u_sucursal' && suc?.isActive !== false, suc ? `hoy="${suc.targetField}"` : 'FILA AUSENTE');
check('U_TIPOCON -> tipo_de_propuesta', tipocon?.targetField === 'tipo_de_propuesta' && tipocon?.isActive !== false, tipocon ? `hoy="${tipocon.targetField}"` : 'FILA AUSENTE');

console.log('\n--- precedencia SAP->HubSpot en contactEmployee (gana el ultimo por _id) ---');
const byTarget = {};
rows.filter((r) => r.objectType === 'contact' && r.sourceContext === 'contactEmployee' && r.isActive !== false)
  .forEach((r) => { (byTarget[r.targetField] ||= []).push(r.sourceField); });
Object.entries(byTarget).forEach(([t, fields]) => {
  if (fields.length > 1) console.log(`  propiedad "${t}" la escriben ${fields.length} filas: ${fields.join(' -> ')}  (gana "${fields[fields.length - 1]}")`);
});
if (!Object.values(byTarget).some((f) => f.length > 1)) console.log('  sin colisiones');

console.log('\n--- ultimos WebhookEvents ---');
const evs = await conn.db.collection('WebhookEvents').find({}).sort({ createdAt: -1 }).limit(3).toArray();
for (const ev of evs) {
  const p = ev.payload || {};
  console.log(`\n${ev.eventType} ${ev.status} ${ev.createdAt?.toISOString?.() ?? ev.createdAt}`);
  console.log('  contact.nombre_completo        :', JSON.stringify(p.contact?.nombre_completo));
  console.log('  contactEmployees[0].nombre_completo:', JSON.stringify(p.contactEmployees?.[0]?.nombre_completo));
  console.log('  contact.firstname / middlename / lastname:', JSON.stringify([p.contact?.firstname, p.contact?.middlename, p.contact?.lastname]));
  console.log('  deal.tipo_de_propuesta         :', JSON.stringify(p.deal?.tipo_de_propuesta));
  console.log('  contactEmployees[0].u_sucursal :', JSON.stringify(p.contactEmployees?.[0]?.u_sucursal));
  const ps = ev.sapAudit?.payloadSap || {};
  if (ps.businessPartner) {
    console.log('  SAP CardName:', JSON.stringify(ps.businessPartner.CardName));
    console.log('  SAP ContactEmployees:', JSON.stringify(ps.businessPartner.ContactEmployees));
  }
  if (ps.quotation) console.log('  SAP U_TIPOCON / DocumentsOwner:', JSON.stringify([ps.quotation.U_TIPOCON, ps.quotation.DocumentsOwner]));
  if (ev.lastError) console.log('  lastError:', String(ev.lastError).slice(0, 300));
}

await conn.close();
