import BusinessPartnerCreationConfigRepository
  from '../../../src/infrastructure/config/BusinessPartnerCreationConfigRepository.js';

function buildConfigurationModel(documentsByKey) {
  return {
    findOne({ key }) {
      return { lean: async () => (key in documentsByKey ? { key, value: documentsByKey[key] } : null) };
    },
  };
}

describe('BusinessPartnerCreationConfigRepository', () => {
  const repository = new BusinessPartnerCreationConfigRepository();

  it('devuelve los defaults cuando la clave no existe', async () => {
    const tenantModels = { Configuration: buildConfigurationModel({}) };

    const config = await repository.getBusinessPartnerCreationConfig({ tenantModels });

    expect(config).toEqual({
      payloadStrategy: 'legacyWhitelist',
      contactEmployeeSource: 'dealContact',
      defaults: { BusinessPartner: {}, ContactEmployee: {}, BPAddress: {} },
      addresses: { strategy: 'none', byName: {}, required: [] },
    });
  });

  it('normaliza byName y required a minusculas sin espacios', async () => {
    const tenantModels = {
      Configuration: buildConfigurationModel({
        businessPartnerCreation: {
          payloadStrategy: 'fullMapped',
          contactEmployeeSource: 'payloadArray',
          defaults: { BusinessPartner: { CardType: 'cCustomer' }, BPAddress: { TaxCode: 'IVA' } },
          addresses: {
            strategy: 'payloadArray',
            byName: { '  Factura ': { AddressType: 'bo_BillTo' }, Entrega: { AddressType: 'bo_ShipTo' } },
            required: [' Factura', 'ENTREGA'],
          },
        },
      }),
    };

    const config = await repository.getBusinessPartnerCreationConfig({ tenantModels });

    expect(config.payloadStrategy).toBe('fullMapped');
    expect(config.contactEmployeeSource).toBe('payloadArray');
    expect(config.defaults.BusinessPartner).toEqual({ CardType: 'cCustomer' });
    expect(config.defaults.BPAddress).toEqual({ TaxCode: 'IVA' });
    expect(config.defaults.ContactEmployee).toEqual({});
    expect(config.addresses.byName).toEqual({
      factura: { AddressType: 'bo_BillTo' },
      entrega: { AddressType: 'bo_ShipTo' },
    });
    expect(config.addresses.required).toEqual(['factura', 'entrega']);
  });

  it('nunca lanza: ante un error de lectura devuelve los defaults', async () => {
    const tenantModels = {
      Configuration: {
        findOne() { throw new Error('mongo caido'); },
      },
    };

    const config = await repository.getBusinessPartnerCreationConfig({ tenantModels });

    expect(config.payloadStrategy).toBe('legacyWhitelist');
    expect(config.addresses.strategy).toBe('none');
  });

  it('degrada a los defaults cuando el tenant no es B1', async () => {
    const tenantModels = {
      Configuration: buildConfigurationModel({
        sapFlavor: 'S4',
        businessPartnerCreation: {
          payloadStrategy: 'fullMapped',
          contactEmployeeSource: 'payloadArray',
          addresses: { strategy: 'payloadArray', byName: { factura: {} }, required: ['factura'] },
        },
      }),
    };

    const config = await repository.getBusinessPartnerCreationConfig({ tenantModels });

    expect(config.payloadStrategy).toBe('legacyWhitelist');
    expect(config.addresses.strategy).toBe('none');
    expect(config.addresses.required).toEqual([]);
  });

  it('respeta la config cuando el tenant es B1', async () => {
    const tenantModels = {
      Configuration: buildConfigurationModel({
        sapFlavor: 'B1',
        businessPartnerCreation: { payloadStrategy: 'fullMapped' },
      }),
    };

    expect((await repository.getBusinessPartnerCreationConfig({ tenantModels })).payloadStrategy)
      .toBe('fullMapped');
  });

  it('lee y normaliza propertiesFlags', async () => {
    const tenantModels = {
      Configuration: buildConfigurationModel({
        propertiesFlags: {
          strategy: 'numberedMultiSelect',
          hubspotProperty: ' groupname ',
          min: 1,
          max: 64,
          trueValue: 'tYES',
        },
      }),
    };

    expect(await repository.getPropertiesFlagsConfig({ tenantModels })).toEqual({
      strategy: 'numberedMultiSelect',
      hubspotProperty: 'groupname',
      min: 1,
      max: 64,
      trueValue: 'tYES',
    });
  });

  it('propertiesFlags ausente queda apagado', async () => {
    const tenantModels = { Configuration: buildConfigurationModel({}) };

    expect(await repository.getPropertiesFlagsConfig({ tenantModels })).toEqual({
      strategy: 'none',
      hubspotProperty: null,
      min: 1,
      max: 64,
      trueValue: 'tYES',
    });
  });

  // Bug encontrado en review de Tarea 6: sin este gate, un tenant S/4 que
  // prendiera la strategy hacia que el $select injection (withPropertiesFlagsSelectFields)
  // inyectara PropertiesN contra A_BusinessPartner, que no tiene esos campos ->
  // 400 del Service Layer. Mismo degrade que getBusinessPartnerCreationConfig.
  it('propertiesFlags se apaga para un tenant S/4 aunque la strategy este prendida', async () => {
    const tenantModels = {
      Configuration: buildConfigurationModel({
        sapFlavor: 'S4',
        propertiesFlags: {
          strategy: 'numberedMultiSelect',
          hubspotProperty: 'groupname',
          min: 1,
          max: 64,
          trueValue: 'tYES',
        },
      }),
    };

    expect(await repository.getPropertiesFlagsConfig({ tenantModels })).toEqual({
      strategy: 'none',
      hubspotProperty: null,
      min: 1,
      max: 64,
      trueValue: 'tYES',
    });
  });

  it('usa el tenantContext para flavor guard cuando tenantModels no se pasa', async () => {
    const tenantContext = {
      tenantModels: {
        Configuration: buildConfigurationModel({
          sapFlavor: 'S4',
          businessPartnerCreation: {
            payloadStrategy: 'fullMapped',
            contactEmployeeSource: 'payloadArray',
            addresses: { strategy: 'payloadArray', byName: { factura: {} }, required: ['factura'] },
          },
        }),
      },
    };

    const config = await repository.getBusinessPartnerCreationConfig({ tenantContext });

    expect(config.payloadStrategy).toBe('legacyWhitelist');
    expect(config.addresses.strategy).toBe('none');
    expect(config.addresses.required).toEqual([]);
  });
});
