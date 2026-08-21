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
        salesArea: { salesOrganization: 'FQCR', distributionChannel: '01', division: 'SC' },
        priceListProperty: 'lista_de_precios_sap',
        currencyProperty: 'moneda_precio_sap',
        priceSourceProperty: 'origen_precio_sap',
      }),
    });

    expect(config).toEqual({
      conditionType: 'ZPR0',
      defaultPriceListType: 'ZC',
      salesArea: { salesOrganization: 'FQCR', distributionChannel: '01', division: 'SC' },
      priceListProperty: 'lista_de_precios_sap',
      currencyProperty: 'moneda_precio_sap',
      priceSourceProperty: 'origen_precio_sap',
    });
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

  // I6 de la revisión final: `division` es opcional. Hay clientes cuyas filas de
  // A_CustomerSalesArea traen `Division` vacía; exigiéndola, el área colapsaba a null y no había
  // configuración posible. Los dos campos que SÍ entran al $filter siguen siendo obligatorios.
  it('acepta un salesArea sin division (division no entra al filtro de condiciones)', async () => {
    const config = await repository.resolveS4PriceListConfig({
      tenantModels: buildTenantModels({
        defaultPriceListType: 'ZC',
        salesArea: { salesOrganization: 'fqcr', distributionChannel: '01' },
      }),
    });

    expect(config.salesArea).toEqual({
      salesOrganization: 'FQCR',
      distributionChannel: '01',
      division: null,
    });
  });

  it('usa ZPR0 como conditionType por defecto y deja opcionales en null', async () => {
    const config = await repository.resolveS4PriceListConfig({
      tenantModels: buildTenantModels({ defaultPriceListType: 'ZC' }),
    });

    expect(config.conditionType).toBe('ZPR0');
    expect(config.salesArea).toBeNull();
    expect(config.priceListProperty).toBeNull();
    expect(config.currencyProperty).toBeNull();
    expect(config.priceSourceProperty).toBeNull();
  });

  it('descarta un salesArea sin distributionChannel en vez de armar un filtro a medias', async () => {
    const config = await repository.resolveS4PriceListConfig({
      tenantModels: buildTenantModels({
        defaultPriceListType: 'ZC',
        salesArea: { salesOrganization: 'FQCR' },
      }),
    });

    expect(config.salesArea).toBeNull();
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
