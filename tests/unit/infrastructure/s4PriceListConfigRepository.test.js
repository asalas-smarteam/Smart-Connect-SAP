import { jest } from '@jest/globals';
import TenantLineItemPriceConfigRepository from '../../../src/infrastructure/repositories/TenantLineItemPriceConfigRepository.js';

function buildTenantModels(value) {
  return {
    Configuration: {
      findOne: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(
          value === undefined ? null : { key: 's4PriceList', value }
        ),
      }),
      findOneAndUpdate: jest.fn().mockResolvedValue(
        value === undefined ? null : { key: 's4PriceList', value }
      ),
      updateOne: jest.fn().mockResolvedValue({}),
    },
  };
}

describe('TenantLineItemPriceConfigRepository.resolveS4PriceListConfig', () => {
  const repository = new TenantLineItemPriceConfigRepository();

  it('normaliza la config completa', async () => {
    const config = await repository.resolveS4PriceListConfig({
      tenantModels: buildTenantModels({
        conditionType: 'ZPR0',
        defaultPriceListType: 'zc',
        defaultPriceListBySalesArea: { ' dpdo/01 ': 'zc', 'CPDO/01': 'ZD' },
        priceListProperty: 'lista_de_precios_sap',
        currencyProperty: 'moneda_precio_sap',
        priceSourceProperty: 'origen_precio_sap',
      }),
    });

    expect(config).toEqual({
      conditionType: 'ZPR0',
      defaultPriceListType: 'ZC',
      defaultPriceListBySalesArea: { 'DPDO/01': 'ZC', 'CPDO/01': 'ZD' },
      priceListProperty: 'lista_de_precios_sap',
      currencyProperty: 'moneda_precio_sap',
      priceSourceProperty: 'origen_precio_sap',
    });
  });

  // El área de ventas ahora la declara el negocio de HubSpot, no la config: si un documento viejo
  // todavía trae `salesArea`, el resultado NO puede exponerla o el caso de uso tendría dos
  // fuentes para lo mismo y ninguna forma de saber cuál gana.
  it('ignora un salesArea que haya quedado en el documento', async () => {
    const config = await repository.resolveS4PriceListConfig({
      tenantModels: buildTenantModels({
        defaultPriceListType: 'ZC',
        salesArea: { salesOrganization: 'FQCR', distributionChannel: '01', division: 'SC' },
      }),
    });

    expect(config).not.toHaveProperty('salesArea');
  });

  // M3 de la revisión final: se leía con tenantConfigurationService.getValue(..., null), que
  // UPSERTA `{ key: 's4PriceList', value: null }` en la base del cliente la primera vez que la
  // clave falta, y después tira el error. La lectura no puede escribir nada.
  it('lee la config sin escribir en la base del tenant (ni upsert del fallback)', async () => {
    const tenantModels = buildTenantModels({ defaultPriceListType: 'ZC' });

    await repository.resolveS4PriceListConfig({ tenantModels });

    expect(tenantModels.Configuration.findOne).toHaveBeenCalledWith({ key: 's4PriceList' });
    expect(tenantModels.Configuration.findOneAndUpdate).not.toHaveBeenCalled();
    expect(tenantModels.Configuration.updateOne).not.toHaveBeenCalled();
  });

  it('tampoco escribe cuando la config NO existe: falla y deja la base limpia', async () => {
    const tenantModels = buildTenantModels(undefined);

    await expect(
      repository.resolveS4PriceListConfig({ tenantModels })
    ).rejects.toThrow('Configuration s4PriceList is required');

    expect(tenantModels.Configuration.findOneAndUpdate).not.toHaveBeenCalled();
    expect(tenantModels.Configuration.updateOne).not.toHaveBeenCalled();
  });

  it('usa ZPR0 como conditionType por defecto y deja opcionales en null', async () => {
    const config = await repository.resolveS4PriceListConfig({
      tenantModels: buildTenantModels({ defaultPriceListType: 'ZC' }),
    });

    expect(config.conditionType).toBe('ZPR0');
    expect(config.defaultPriceListBySalesArea).toEqual({});
    expect(config.priceListProperty).toBeNull();
    expect(config.currencyProperty).toBeNull();
    expect(config.priceSourceProperty).toBeNull();
  });

  it.each([
    ['ausente', undefined],
    ['null', null],
    ['un arreglo', [['DPDO/01', 'ZC']]],
    ['un string', 'DPDO/01=ZC'],
  ])('devuelve {} cuando defaultPriceListBySalesArea es %s', async (_label, mapa) => {
    const config = await repository.resolveS4PriceListConfig({
      tenantModels: buildTenantModels({
        defaultPriceListType: 'ZC',
        defaultPriceListBySalesArea: mapa,
      }),
    });

    expect(config.defaultPriceListBySalesArea).toEqual({});
  });

  // Una clave mal escrita NO puede dejar sin precios a todo el tenant: se descarta esa entrada y
  // esa combinación cae al `defaultPriceListType`, que es obligatorio justamente para eso.
  it.each([
    ['sin barra', { DPDO01: 'ZC' }],
    ['con dos barras', { 'DPDO/01/SC': 'ZC' }],
    ['con la organizacion vacia', { '/01': 'ZC' }],
    ['con el canal vacio', { 'DPDO/': 'ZC' }],
    ['con valor vacio', { 'DPDO/01': '   ' }],
  ])('descarta la entrada %s y conserva las validas', async (_label, mala) => {
    const config = await repository.resolveS4PriceListConfig({
      tenantModels: buildTenantModels({
        defaultPriceListType: 'ZC',
        defaultPriceListBySalesArea: { ...mala, 'MQGT/01': 'ZA' },
      }),
    });

    expect(config.defaultPriceListBySalesArea).toEqual({ 'MQGT/01': 'ZA' });
  });

  // El canal NO se re-normaliza numéricamente a propósito: SAP devuelve "01", y hacer que "1" sea
  // equivalente esconde una config mal cargada en vez de mostrarla.
  it('no equipara el canal "1" con el "01" que devuelve SAP', async () => {
    const config = await repository.resolveS4PriceListConfig({
      tenantModels: buildTenantModels({
        defaultPriceListType: 'ZC',
        defaultPriceListBySalesArea: { 'DPDO/1': 'ZD' },
      }),
    });

    expect(config.defaultPriceListBySalesArea).toEqual({ 'DPDO/1': 'ZD' });
    expect(config.defaultPriceListBySalesArea['DPDO/01']).toBeUndefined();
  });

  it('falla con mensaje accionable cuando no hay documento de config', async () => {
    await expect(
      repository.resolveS4PriceListConfig({ tenantModels: buildTenantModels(undefined) })
    ).rejects.toThrow('Configuration s4PriceList is required');
  });

  it('falla cuando falta defaultPriceListType', async () => {
    await expect(
      repository.resolveS4PriceListConfig({ tenantModels: buildTenantModels({ conditionType: 'ZPR0' }) })
    ).rejects.toThrow('s4PriceList.defaultPriceListType is required');
  });
});
