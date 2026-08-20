import {
  QUOTATION_BASE_TYPE,
  buildOrderFromQuotationPayload,
  buildOrderPayload,
  buildQuotationLineUpdates,
  buildQuotationPayload,
  mapHubspotToSapFields,
  normalizeDocumentSpecialLines,
  pickMappedHeaderFields,
} from '../../../src/domain/orders/order-builder.service.js';

describe('order-builder.service buildQuotationPayload', () => {
  it('builds a Quotation payload with Comments del mapeo y SalesPersonCode', () => {
    const payload = buildQuotationPayload({
      cardCode: 'CL00129',
      documentLines: [{ ItemCode: 'A01', Quantity: 1, UnitPrice: 10 }],
      slpCode: 5,
      mappedDealFields: { Comments: 'Oferta creada desde HubSpot' },
    });

    expect(payload).toMatchObject({
      CardCode: 'CL00129',
      Comments: 'Oferta creada desde HubSpot',
      SalesPersonCode: 5,
      DocumentLines: [{ ItemCode: 'A01', Quantity: 1, UnitPrice: 10 }],
    });
    expect(payload.DocDueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('no agrega Comments cuando el mapeo no produjo valor', () => {
    const payload = buildQuotationPayload({
      cardCode: 'CL00129',
      documentLines: [{ ItemCode: 'A01', Quantity: 1, UnitPrice: 10 }],
    });

    expect(payload).not.toHaveProperty('Comments');
  });

  // Printer mapea NumAtCard <- hs_object_id y hoy recibe HS-DEAL-<id> porque el parametro
  // explicito le gana al mapeo. Este test fija que reciba el valor mapeado tal cual.
  it('toma NumAtCard del mapeo, sin prefijo ni parametro que lo pise', () => {
    const payload = buildQuotationPayload({
      cardCode: 'CL00129',
      documentLines: [{ ItemCode: 'A01', Quantity: 1, UnitPrice: 10 }],
      mappedDealFields: { NumAtCard: '64175519381' },
    });

    expect(payload.NumAtCard).toBe('64175519381');
  });

  it('no agrega NumAtCard cuando el mapeo no produjo valor', () => {
    const payload = buildQuotationPayload({
      cardCode: 'CL00129',
      documentLines: [{ ItemCode: 'A01', Quantity: 1, UnitPrice: 10 }],
    });

    expect(payload).not.toHaveProperty('NumAtCard');
  });

  it('uses the DocDueDate mapped from HubSpot instead of today', () => {
    const payload = buildQuotationPayload({
      cardCode: 'CL00129',
      documentLines: [{ ItemCode: 'A01', Quantity: 1, UnitPrice: 10 }],
      mappedDealFields: { DocDueDate: '2026-07-21' },
    });

    expect(payload.DocDueDate).toBe('2026-07-21');
  });

  it('throws when there are no document lines', () => {
    expect(() => buildQuotationPayload({ cardCode: 'CL1', documentLines: [] })).toThrow(
      /At least one line_item/
    );
  });

  // Series y DocDate son inmutables solo en el PATCH de updateQuotation (ver
  // processQuotationFlows.test.js): ahi identifican o fechan un documento que ya existe en SAP.
  // Al CREAR no aplica ese motivo, asi que tienen que seguir viajando igual que cualquier otro
  // campo mapeado.
  it('lleva Series y DocDate al crear, porque IMMUTABLE_ON_PATCH_FIELDS solo aplica al PATCH', () => {
    const payload = buildQuotationPayload({
      cardCode: 'CL00129',
      documentLines: [{ ItemCode: 'A01', Quantity: 1, UnitPrice: 10 }],
      mappedDealFields: { Series: '240', DocDate: '2026-08-01' },
    });

    expect(payload.Series).toBe('240');
    expect(payload.DocDate).toBe('2026-08-01');
  });
});

describe('order-builder.service normalizeDocumentSpecialLines', () => {
  it('wraps the mapped texto_gobierno string into the collection SAP expects', () => {
    expect(normalizeDocumentSpecialLines('Garantía: 12 Meses')).toEqual([
      { LineType: 'dslt_Text', AfterLineNumber: 0, LineText: 'Garantía: 12 Meses' },
    ]);
  });

  it('anchors the text after the line number it is given', () => {
    expect(normalizeDocumentSpecialLines('texto', { afterLineNumber: 3 })).toEqual([
      { LineType: 'dslt_Text', AfterLineNumber: 3, LineText: 'texto' },
    ]);
  });

  it('keeps a multiline text as a single line so wrapped sentences are not cut', () => {
    const text = 'Capacidad de \nhojas en bandeja: 550\nO.C: 111931, N.O.G: 29412315';

    expect(normalizeDocumentSpecialLines(text)).toEqual([
      { LineType: 'dslt_Text', AfterLineNumber: 0, LineText: text },
    ]);
  });

  it('returns null for empty, blank or missing values', () => {
    expect(normalizeDocumentSpecialLines('')).toBeNull();
    expect(normalizeDocumentSpecialLines('   ')).toBeNull();
    expect(normalizeDocumentSpecialLines(null)).toBeNull();
    expect(normalizeDocumentSpecialLines(undefined)).toBeNull();
    expect(normalizeDocumentSpecialLines([])).toBeNull();
  });

  it('passes through a collection that is already shaped', () => {
    const lines = [{ LineType: 'dslt_Text', AfterLineNumber: 0, LineText: 'ya viene armado' }];

    expect(normalizeDocumentSpecialLines(lines)).toBe(lines);
  });
});

describe('order-builder.service DocumentSpecialLines in header payloads', () => {
  const documentLines = [{ ItemCode: 'A01', Quantity: 1, UnitPrice: 10 }];

  it('reshapes DocumentSpecialLines on a Quotation instead of sending the raw string', () => {
    const payload = buildQuotationPayload({
      cardCode: 'CL00129',
      documentLines,
      mappedDealFields: { DocumentSpecialLines: 'O.C: 111931, N.O.G: 29412315' },
    });

    expect(payload.DocumentSpecialLines).toEqual([
      { LineType: 'dslt_Text', AfterLineNumber: 0, LineText: 'O.C: 111931, N.O.G: 29412315' },
    ]);
  });

  it('reshapes DocumentSpecialLines on an Order too', () => {
    const payload = buildOrderPayload({
      cardCode: 'CL00129',
      documentLines,
      mappedDealFields: { DocumentSpecialLines: 'texto gobierno' },
    });

    expect(payload.DocumentSpecialLines).toEqual([
      { LineType: 'dslt_Text', AfterLineNumber: 0, LineText: 'texto gobierno' },
    ]);
  });

  it('anchors the text after the last document line so SAP has somewhere to put it', () => {
    const payload = buildQuotationPayload({
      cardCode: 'CL00129',
      documentLines: [
        { ItemCode: 'A01', Quantity: 1, UnitPrice: 10 },
        { ItemCode: 'A02', Quantity: 1, UnitPrice: 20 },
      ],
      mappedDealFields: { DocumentSpecialLines: 'texto gobierno' },
    });

    expect(payload.DocumentSpecialLines[0].AfterLineNumber).toBe(1);
  });

  it('omits DocumentSpecialLines entirely when the deal has no texto_gobierno', () => {
    const payload = buildQuotationPayload({
      cardCode: 'CL00129',
      documentLines,
      mappedDealFields: { DocumentSpecialLines: '   ' },
    });

    expect(payload).not.toHaveProperty('DocumentSpecialLines');
  });

  it('leaves the rest of the mapped header fields untouched', () => {
    const payload = buildQuotationPayload({
      cardCode: 'CL00129',
      documentLines,
      mappedDealFields: {
        DocumentSpecialLines: 'texto gobierno',
        U_BAJA_CUANTIA: 'N',
        Series: '240',
      },
    });

    expect(payload).toMatchObject({ U_BAJA_CUANTIA: 'N', Series: '240' });
  });
});

// documentLineCount llega desde link.lines.length en ProcessHubspotUpdateQuotation (ver
// processQuotationFlows.test.js). Ese call site nunca alcanza 0 en la practica porque
// buildQuotationLineUpdates ya revienta antes si no hay ninguna linea que matchee, pero
// pickMappedHeaderFields tiene que seguir siendo segura si algun otro caller le pasa 0 o nada.
describe('order-builder.service pickMappedHeaderFields ancla DocumentSpecialLines sin explotar en el limite', () => {
  it('no explota y ancla en 0 (no negativo) cuando documentLineCount es 0', () => {
    const fields = pickMappedHeaderFields(
      { DocumentSpecialLines: 'texto gobierno' },
      { documentLineCount: 0 }
    );

    expect(fields.DocumentSpecialLines[0].AfterLineNumber).toBe(0);
  });

  it('no explota cuando se omite el segundo argumento por completo', () => {
    const fields = pickMappedHeaderFields({ DocumentSpecialLines: 'texto gobierno' });

    expect(fields.DocumentSpecialLines[0].AfterLineNumber).toBe(0);
  });
});

describe('order-builder.service buildOrderFromQuotationPayload', () => {
  it('builds DocumentLines referencing the quotation with BaseType 23', () => {
    const payload = buildOrderFromQuotationPayload({
      cardCode: 'CL00129',
      baseEntry: 12345,
      baseLines: [{ sapLineNum: 0 }, { sapLineNum: 1 }],
      slpCode: 7,
    });

    expect(QUOTATION_BASE_TYPE).toBe(23);
    expect(payload.CardCode).toBe('CL00129');
    expect(payload.SalesPersonCode).toBe(7);
    expect(payload.DocumentLines).toEqual([
      { BaseType: 23, BaseEntry: 12345, BaseLine: 0 },
      { BaseType: 23, BaseEntry: 12345, BaseLine: 1 },
    ]);
  });

  it('accepts plain numeric base lines', () => {
    const payload = buildOrderFromQuotationPayload({
      cardCode: 'CL1',
      baseEntry: 9,
      baseLines: [0, 2],
    });

    expect(payload.DocumentLines).toEqual([
      { BaseType: 23, BaseEntry: 9, BaseLine: 0 },
      { BaseType: 23, BaseEntry: 9, BaseLine: 2 },
    ]);
  });

  it('uses the DocDueDate mapped from HubSpot instead of today', () => {
    const payload = buildOrderFromQuotationPayload({
      cardCode: 'CL00129',
      baseEntry: 12345,
      baseLines: [0],
      mappedDealFields: { DocDueDate: '2026-07-21' },
    });

    expect(payload.DocDueDate).toBe('2026-07-21');
  });

  it('falls back to today when the deal carries no DocDueDate', () => {
    const payload = buildOrderFromQuotationPayload({
      cardCode: 'CL00129',
      baseEntry: 12345,
      baseLines: [0],
    });

    expect(payload.DocDueDate).toBe(new Date().toISOString().slice(0, 10));
  });

  it('throws when baseEntry is invalid', () => {
    expect(() => buildOrderFromQuotationPayload({ cardCode: 'CL1', baseEntry: null, baseLines: [0] })).toThrow(
      /valid quotation BaseEntry/
    );
  });

  it('throws when there are no base lines', () => {
    expect(() => buildOrderFromQuotationPayload({ cardCode: 'CL1', baseEntry: 1, baseLines: [] })).toThrow(
      /At least one quotation line/
    );
  });

  it('derrama los campos mapeados del contexto orders-quotations en la cabecera', () => {
    const payload = buildOrderFromQuotationPayload({
      cardCode: 'CL00129',
      baseEntry: 12345,
      baseLines: [0],
      mappedDealFields: { NumAtCard: 'OC #P06485', Comments: 'Comentario del comprador' },
    });

    expect(payload.NumAtCard).toBe('OC #P06485');
    expect(payload.Comments).toBe('Comentario del comprador');
  });

  // La regla que pidió el cliente: sin valor en HubSpot, el campo no viaja y SAP lo deja nulo.
  // Nunca un default del integrador.
  it('no inventa NumAtCard ni Comments cuando el mapeo no produjo valores', () => {
    const payload = buildOrderFromQuotationPayload({
      cardCode: 'CL00129',
      baseEntry: 12345,
      baseLines: [0],
    });

    expect(payload).not.toHaveProperty('NumAtCard');
    expect(payload).not.toHaveProperty('Comments');
  });

  it('no deja que el derrame pise lo que el builder posee', () => {
    const payload = buildOrderFromQuotationPayload({
      cardCode: 'CL00129',
      baseEntry: 12345,
      baseLines: [0],
      mappedDealFields: {
        CardCode: 'HACKED',
        DocumentLines: [{ ItemCode: 'X' }],
        DocDueDate: '2026-07-21',
      },
    });

    expect(payload.CardCode).toBe('CL00129');
    expect(payload.DocumentLines).toEqual([{ BaseType: 23, BaseEntry: 12345, BaseLine: 0 }]);
    expect(payload.DocDueDate).toBe('2026-07-21');
  });
});

describe('order-builder.service buildQuotationLineUpdates', () => {
  const productMappings = [
    { sourceField: 'ItemCode', targetField: 'hs_sku' },
    { sourceField: 'Quantity', targetField: 'quantity' },
    { sourceField: 'UnitPrice', targetField: 'price' },
  ];
  const linkLines = [
    { hubspotLineItemId: 'li-1', sapLineNum: 0 },
    { hubspotLineItemId: 'li-2', sapLineNum: 1 },
  ];

  it('builds line updates matched by stored LineNum (existing lines only)', () => {
    const updates = buildQuotationLineUpdates({
      productMappings,
      linkLines,
      taxCodes: [{ Rate: 15, Code: 'IVA' }],
      discountConfig: { isRequired: true, fieldMappings: {} },
      lineItems: [
        {
          hubspot_id: 'li-1',
          hs_sku: 'A01',
          quantity: '2',
          price: '17.5',
          hs_discount_percentage: '5',
          hs_tax_rate: '15.0000',
        },
      ],
    });

    expect(updates).toEqual([
      {
        LineNum: 0,
        UnitPrice: 17.5,
        Quantity: 2,
        DiscountPercent: 5,
        TaxCode: 'IVA',
      },
    ]);
  });

  it('matches by product id and takes UnitPrice from `price` and WarehouseCode from the payload', () => {
    // HubSpot workflow sends the product id in hubspot_id instead of the line item id,
    // the price in `price`, and may change the warehouse via `warehouseCode`.
    const updates = buildQuotationLineUpdates({
      productMappings,
      linkLines: [
        { hubspotLineItemId: '56431574047', hubspotProductId: '45616885779', sku: '101-0029', sapLineNum: 0 },
      ],
      taxCodes: [{ Rate: 15, Code: 'IVA' }],
      discountConfig: { isRequired: true, fieldMappings: {} },
      lineItems: [
        {
          hubspot_id: '45616885779',
          hs_sku: '101-0029',
          quantity: '2',
          price: '86302.62',
          hs_discount_percentage: '0',
          hs_tax_rate: '15.0000',
          warehouseCode: '02',
        },
      ],
    });

    expect(updates).toEqual([
      { LineNum: 0, UnitPrice: 86302.62, Quantity: 2, DiscountPercent: 0, WarehouseCode: '02', TaxCode: 'IVA' },
    ]);
  });

  it('omits DiscountPercent when requireDiscounts.isRequired is false', () => {
    const updates = buildQuotationLineUpdates({
      productMappings,
      linkLines,
      taxCodes: [{ Rate: 15, Code: 'IVA' }],
      discountConfig: { isRequired: false, fieldMappings: { Discount: 'hs_discount_percentage' } },
      lineItems: [
        {
          hubspot_id: 'li-1',
          hs_sku: 'A01',
          quantity: '2',
          price: '17.5',
          hs_discount_percentage: '5',
          hs_tax_rate: '15.0000',
        },
      ],
    });

    expect(updates[0]).not.toHaveProperty('DiscountPercent');
  });

  it('reads the discount from the configured fieldMappings.Discount field', () => {
    const updates = buildQuotationLineUpdates({
      productMappings,
      linkLines,
      discountConfig: { isRequired: true, fieldMappings: { Discount: 'discount' } },
      lineItems: [
        {
          hubspot_id: 'li-1',
          hs_sku: 'A01',
          quantity: '2',
          price: '17.5',
          discount: '8',
          hs_discount_percentage: '5',
        },
      ],
    });

    expect(updates[0].DiscountPercent).toBe(8);
  });

  it('falls back to SKU matching when no id matches', () => {
    const updates = buildQuotationLineUpdates({
      productMappings,
      linkLines: [{ hubspotLineItemId: 'x', hubspotProductId: 'y', sku: '101-0029', sapLineNum: 3 }],
      lineItems: [{ hs_sku: '101-0029', quantity: '1', price: '5' }],
    });

    expect(updates).toEqual([{ LineNum: 3, UnitPrice: 5, Quantity: 1 }]);
  });

  it('throws when none match by id or SKU', () => {
    expect(() =>
      buildQuotationLineUpdates({
        productMappings,
        linkLines,
        lineItems: [{ hubspot_id: 'unknown', hs_sku: 'A99', price: '1' }],
      })
    ).toThrow(/No matching quotation lines/);
  });
});

describe('order-builder.service buildOrderPayload toma la cabecera del mapeo', () => {
  const documentLines = [{ ItemCode: 'A01', Quantity: 1, UnitPrice: 10 }];

  // Los cinco campos que antes se leian por nombre fijo desde el codigo. Son los de noelito:
  // sus filas de FieldMapping ya estan cargadas en produccion.
  it('derrama los cinco campos que antes venian hardcodeados', () => {
    const payload = buildOrderPayload({
      cardCode: 'CL00129',
      documentLines,
      mappedDealFields: {
        Comments: 'llevar el dia de maniana',
        U_ACO_Telefono: '+50583635946',
        U_ACO_Telefono2: '+50588887777',
        Address: 'Managua centro',
        Address2: 'Jalapa contiguo al mercado',
      },
    });

    expect(payload).toMatchObject({
      Comments: 'llevar el dia de maniana',
      U_ACO_Telefono: '+50583635946',
      U_ACO_Telefono2: '+50588887777',
      Address: 'Managua centro',
      Address2: 'Jalapa contiguo al mercado',
    });
  });

  it('no inventa ninguno de esos campos cuando el mapeo no produjo valores', () => {
    const payload = buildOrderPayload({ cardCode: 'CL00129', documentLines });

    for (const field of ['Comments', 'U_ACO_Telefono', 'U_ACO_Telefono2', 'Address', 'Address2']) {
      expect(payload).not.toHaveProperty(field);
    }
  });

  it('no deja que el derrame pise lo que el builder posee', () => {
    const payload = buildOrderPayload({
      cardCode: 'CL00129',
      documentLines,
      paymentGroupCode: 3,
      mappedDealFields: { CardCode: 'HACKED', PaymentGroupCode: 99, DocumentLines: [] },
    });

    expect(payload.CardCode).toBe('CL00129');
    expect(payload.PaymentGroupCode).toBe(3);
    expect(payload.DocumentLines).toEqual(documentLines);
  });

  // Un valor de puros espacios es la misma basura que '' o los textos "null"/"undefined":
  // mapHubspotToSapFields ya lo descarta (ver mapHubspotToSapFields.test.js), asi que por el
  // momento en que mappedDealFields llega a buildOrderPayload la clave ya no esta. Se pasa por
  // el mapeador de verdad, no a mano, porque eso es lo que asegura que el builder nunca ve el
  // valor sucio en el flujo real (el bug que motivo este test era justamente que SI lo veia).
  it('un valor de solo espacios en el mapeo no llega al payload', () => {
    const mappedDealFields = mapHubspotToSapFields(
      { comments: '   ' },
      [{ sourceField: 'Comments', targetField: 'comments' }]
    );

    const payload = buildOrderPayload({ cardCode: 'CL00129', documentLines, mappedDealFields });

    expect(payload).not.toHaveProperty('Comments');
  });
});
