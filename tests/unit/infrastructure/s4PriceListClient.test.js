import { jest } from '@jest/globals';
import {
  S4PriceListClient,
  CUSTOMER_SALES_AREA_PATH,
  CONDITION_VALIDITY_PATH,
  CONDITION_RECORD_PATH,
} from '../../../src/infrastructure/sap/S4PriceListClient.js';

// Filas tal como salen del transporte: las fechas ya vienen en ISO porque
// normalizeODataV2Response convierte /Date(ms)/ antes de devolverlas.
const VALIDITY_ROWS = [
  {
    ConditionRecord: '0000418608',
    ConditionType: 'ZPR0',
    PriceListType: 'ZC',
    Material: '80000017',
    SalesOrganization: 'FQCR',
    DistributionChannel: '01',
    ConditionValidityStartDate: '2026-01-23T00:00:00.000Z',
    ConditionValidityEndDate: '2026-12-31T00:00:00.000Z',
  },
  {
    ConditionRecord: '0000418745',
    ConditionType: 'ZPR0',
    PriceListType: '',
    Material: '80000017',
    SalesOrganization: 'FQCR',
    DistributionChannel: '01',
    ConditionValidityStartDate: '2026-01-27T00:00:00.000Z',
    ConditionValidityEndDate: '2026-12-31T00:00:00.000Z',
  },
];

const RECORD_ROWS = [
  {
    ConditionRecord: '0000418608',
    ConditionTable: '502',
    ConditionType: 'ZPR0',
    ConditionRateValue: '1.2800',
    ConditionCurrency: 'USD',
    ConditionQuantity: '1',
    ConditionQuantityUnit: 'KG',
    ConditionIsDeleted: false,
  },
  {
    ConditionRecord: '0000418745',
    ConditionTable: '504',
    ConditionType: 'ZPR0',
    ConditionRateValue: '1.2500',
    ConditionCurrency: 'USD',
    ConditionQuantity: '1',
    ConditionQuantityUnit: 'KG',
    ConditionIsDeleted: false,
  },
];

function buildTransport({ validity = VALIDITY_ROWS, records = RECORD_ROWS, salesAreas = [] } = {}) {
  return {
    fetchAll: jest.fn(async ({ path }) => {
      if (path === CUSTOMER_SALES_AREA_PATH) return salesAreas;
      if (path === CONDITION_VALIDITY_PATH) return validity;
      if (path === CONDITION_RECORD_PATH) return records;
      throw new Error(`unexpected path ${path}`);
    }),
  };
}

function filterOf(transport, path) {
  const call = transport.fetchAll.mock.calls.find(([options]) => options.path === path);
  return decodeURIComponent(call[0].query.$filter);
}

describe('S4PriceListClient', () => {
  it('exige un transport', () => {
    expect(() => new S4PriceListClient({})).toThrow('transport is required');
  });

  it('filtra las áreas de venta por cliente y escapa la comilla simple', async () => {
    const transport = buildTransport({ salesAreas: [{ Customer: "O'BRIEN" }] });
    const client = new S4PriceListClient({ transport });

    const rows = await client.fetchCustomerSalesAreas("O'BRIEN");

    expect(rows).toEqual([{ Customer: "O'BRIEN" }]);
    expect(filterOf(transport, CUSTOMER_SALES_AREA_PATH)).toBe("Customer eq 'O''BRIEN'");
  });

  it('no llama al transporte cuando no hay cliente', async () => {
    const transport = buildTransport();
    const client = new S4PriceListClient({ transport });

    expect(await client.fetchCustomerSalesAreas('  ')).toEqual([]);
    expect(transport.fetchAll).not.toHaveBeenCalled();
  });

  // El área de ventas la declara el negocio de HubSpot, así que se filtra en SAP y la respuesta
  // trae 0 o 1 fila: `Customer + SalesOrganization + DistributionChannel` identifica una sola
  // (verificado el 2026-08-24 sobre las 8974 filas del sistema, cero duplicados).
  it('filtra también por organización de ventas y canal cuando llegan los dos', async () => {
    const transport = buildTransport({ salesAreas: [{ Customer: '100061', PriceListType: 'ZD' }] });
    const client = new S4PriceListClient({ transport });

    const rows = await client.fetchCustomerSalesAreas('100061', {
      salesOrganization: 'CPDO',
      distributionChannel: '01',
    });

    expect(rows).toEqual([{ Customer: '100061', PriceListType: 'ZD' }]);
    expect(filterOf(transport, CUSTOMER_SALES_AREA_PATH)).toBe(
      "Customer eq '100061' and SalesOrganization eq 'CPDO' and DistributionChannel eq '01'"
    );
  });

  // Sin el segundo argumento se comporta como antes: ese camino lo usa el caso de uso para armar
  // la nota que le lista al asesor las áreas que el cliente SÍ tiene.
  it('sin el segundo argumento sigue filtrando sólo por cliente', async () => {
    const transport = buildTransport({ salesAreas: [{ Customer: '100061' }] });
    const client = new S4PriceListClient({ transport });

    await client.fetchCustomerSalesAreas('100061');

    expect(filterOf(transport, CUSTOMER_SALES_AREA_PATH)).toBe("Customer eq '100061'");
  });

  // Un filtro a medias devuelve filas de otros canales y el llamador no tiene forma de notarlo:
  // creería que ésa es el área del negocio y escribiría los precios de otra.
  it.each([
    ['sin canal', { salesOrganization: 'CPDO' }],
    ['sin organizacion', { distributionChannel: '01' }],
    ['con el canal vacio', { salesOrganization: 'CPDO', distributionChannel: '   ' }],
  ])('lanza %s en vez de armar un filtro a medias', async (_label, area) => {
    const transport = buildTransport();
    const client = new S4PriceListClient({ transport });

    await expect(client.fetchCustomerSalesAreas('100061', area)).rejects.toThrow(
      /salesOrganization and distributionChannel must be provided together/
    );
    expect(transport.fetchAll).not.toHaveBeenCalled();
  });

  // Este test AFIRMABA que la hora del momento (15:04:05) viajaba tal cual a los dos literales.
  // Documentaba el comportamiento equivocado: las fechas de vigencia de SAP son fechas puras a
  // medianoche UTC, así que con la hora puesta `ConditionValidityEndDate ge datetime'…T15:04:05'`
  // es FALSO para el registro cuyo último día de vigencia es hoy. Ahora exige el truncado al
  // inicio del día UTC.
  it('filtra la vigencia por condición, material, área de ventas y fecha TRUNCADA al día UTC', async () => {
    const transport = buildTransport();
    const client = new S4PriceListClient({ transport });

    await client.fetchConditionCandidates({
      conditionType: 'ZPR0',
      material: '80000017',
      salesArea: { salesOrganization: 'FQCR', distributionChannel: '01' },
      date: new Date('2026-08-18T15:04:05.000Z'),
    });

    expect(filterOf(transport, CONDITION_VALIDITY_PATH)).toBe(
      "ConditionType eq 'ZPR0' and Material eq '80000017'"
      + " and SalesOrganization eq 'FQCR' and DistributionChannel eq '01'"
      + " and ConditionValidityStartDate le datetime'2026-08-18T00:00:00'"
      + " and ConditionValidityEndDate ge datetime'2026-08-18T00:00:00'"
    );
  });

  // El caso que el bug hacía perder: una lista cuyo último día de vigencia es HOY. Sin truncar,
  // el precio de la lista quedaba fuera del filtro y la línea caía al default del producto, o
  // sea que se escribía un precio equivocado en el CRM sin que nada fallara.
  it('el registro que vence HOY entra en el filtro (comparación evaluada contra el literal emitido)', async () => {
    const transport = buildTransport();
    const client = new S4PriceListClient({ transport });
    // Vigencia real de SAP: último día hoy, a medianoche UTC.
    const recordValidityEnd = new Date('2026-08-18T00:00:00.000Z');
    const recordValidityStart = new Date('2026-01-23T00:00:00.000Z');

    await client.fetchConditionCandidates({
      conditionType: 'ZPR0',
      material: '80000017',
      salesArea: { salesOrganization: 'FQCR', distributionChannel: '01' },
      // Hora del momento en el último día de vigencia.
      date: new Date('2026-08-18T21:37:04.000Z'),
    });

    const filter = filterOf(transport, CONDITION_VALIDITY_PATH);
    const startLiteral = /ConditionValidityStartDate le datetime'([^']+)'/.exec(filter)[1];
    const endLiteral = /ConditionValidityEndDate ge datetime'([^']+)'/.exec(filter)[1];

    // `ConditionValidityEndDate ge <literal>` tiene que ser VERDADERO para el registro que
    // vence hoy: el literal no puede ser posterior a su fecha de fin.
    expect(new Date(`${endLiteral}Z`).getTime()).toBeLessThanOrEqual(recordValidityEnd.getTime());
    // Y `ConditionValidityStartDate le <literal>` sigue siendo verdadero para su fecha de inicio.
    expect(new Date(`${startLiteral}Z`).getTime()).toBeGreaterThanOrEqual(
      recordValidityStart.getTime()
    );
  });

  it('una fecha ya a medianoche UTC viaja sin cambios', async () => {
    const transport = buildTransport();
    const client = new S4PriceListClient({ transport });

    await client.fetchConditionCandidates({
      conditionType: 'ZPR0',
      material: '80000017',
      salesArea: { salesOrganization: 'FQCR', distributionChannel: '01' },
      date: new Date('2026-08-18T00:00:00.000Z'),
    });

    expect(filterOf(transport, CONDITION_VALIDITY_PATH)).toContain(
      "ConditionValidityEndDate ge datetime'2026-08-18T00:00:00'"
    );
  });

  it('rechaza una fecha ausente o inválida en vez de emitir un literal con NaN', async () => {
    const transport = buildTransport();
    const client = new S4PriceListClient({ transport });

    await expect(
      client.fetchConditionCandidates({
        conditionType: 'ZPR0',
        material: '80000017',
        salesArea: { salesOrganization: 'FQCR', distributionChannel: '01' },
        date: undefined,
      })
    ).rejects.toThrow(/date is required for fetchConditionCandidates/);

    expect(transport.fetchAll).not.toHaveBeenCalled();
  });

  it('rechaza salesArea ausente', async () => {
    const transport = buildTransport();
    const client = new S4PriceListClient({ transport });

    await expect(
      client.fetchConditionCandidates({
        conditionType: 'ZPR0',
        material: '80000017',
        salesArea: undefined,
        date: new Date('2026-08-18T00:00:00.000Z'),
      })
    ).rejects.toThrow(/salesArea\.salesOrganization is required/);

    expect(transport.fetchAll).not.toHaveBeenCalled();
  });

  it('rechaza salesArea sin salesOrganization', async () => {
    const transport = buildTransport();
    const client = new S4PriceListClient({ transport });

    await expect(
      client.fetchConditionCandidates({
        conditionType: 'ZPR0',
        material: '80000017',
        salesArea: { distributionChannel: '01' },
        date: new Date('2026-08-18T00:00:00.000Z'),
      })
    ).rejects.toThrow(/salesArea\.salesOrganization is required/);

    expect(transport.fetchAll).not.toHaveBeenCalled();
  });

  it('rechaza salesArea sin distributionChannel', async () => {
    const transport = buildTransport();
    const client = new S4PriceListClient({ transport });

    await expect(
      client.fetchConditionCandidates({
        conditionType: 'ZPR0',
        material: '80000017',
        salesArea: { salesOrganization: 'FQCR' },
        date: new Date('2026-08-18T00:00:00.000Z'),
      })
    ).rejects.toThrow(/salesArea\.distributionChannel is required/);

    expect(transport.fetchAll).not.toHaveBeenCalled();
  });

  it('trae todas las tarifas en UNA llamada con or sobre ConditionRecord', async () => {
    const transport = buildTransport();
    const client = new S4PriceListClient({ transport });

    await client.fetchConditionCandidates({
      conditionType: 'ZPR0',
      material: '80000017',
      salesArea: { salesOrganization: 'FQCR', distributionChannel: '01' },
      date: new Date('2026-08-18T00:00:00.000Z'),
    });

    const recordCalls = transport.fetchAll.mock.calls.filter(
      ([options]) => options.path === CONDITION_RECORD_PATH
    );
    expect(recordCalls).toHaveLength(1);
    expect(filterOf(transport, CONDITION_RECORD_PATH)).toBe(
      "ConditionRecord eq '0000418608' or ConditionRecord eq '0000418745'"
    );
  });

  it('junta el PriceListType de la vigencia con la tarifa del registro y numeriza', async () => {
    const transport = buildTransport();
    const client = new S4PriceListClient({ transport });

    const candidates = await client.fetchConditionCandidates({
      conditionType: 'ZPR0',
      material: '80000017',
      salesArea: { salesOrganization: 'FQCR', distributionChannel: '01' },
      date: new Date('2026-08-18T00:00:00.000Z'),
    });

    expect(candidates).toEqual([
      {
        conditionRecord: '0000418608',
        conditionTable: '502',
        priceListType: 'ZC',
        material: '80000017',
        conditionRateValue: 1.28,
        conditionCurrency: 'USD',
        conditionQuantity: 1,
        conditionQuantityUnit: 'KG',
        conditionIsDeleted: false,
      },
      {
        conditionRecord: '0000418745',
        conditionTable: '504',
        priceListType: null,
        material: '80000017',
        conditionRateValue: 1.25,
        conditionCurrency: 'USD',
        conditionQuantity: 1,
        conditionQuantityUnit: 'KG',
        conditionIsDeleted: false,
      },
    ]);
  });

  it('no pide tarifas cuando la vigencia no devolvió nada', async () => {
    const transport = buildTransport({ validity: [] });
    const client = new S4PriceListClient({ transport });

    expect(await client.fetchConditionCandidates({
      conditionType: 'ZPR0',
      material: '99999999',
      salesArea: { salesOrganization: 'FQCR', distributionChannel: '01' },
      date: new Date('2026-08-18T00:00:00.000Z'),
    })).toEqual([]);

    const recordCalls = transport.fetchAll.mock.calls.filter(
      ([options]) => options.path === CONDITION_RECORD_PATH
    );
    expect(recordCalls).toHaveLength(0);
  });

  it('descarta filas de vigencia sin tarifa correspondiente', async () => {
    const transport = buildTransport({ records: [RECORD_ROWS[0]] });
    const client = new S4PriceListClient({ transport });

    const candidates = await client.fetchConditionCandidates({
      conditionType: 'ZPR0',
      material: '80000017',
      salesArea: { salesOrganization: 'FQCR', distributionChannel: '01' },
      date: new Date('2026-08-18T00:00:00.000Z'),
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].conditionRecord).toBe('0000418608');
  });
});
