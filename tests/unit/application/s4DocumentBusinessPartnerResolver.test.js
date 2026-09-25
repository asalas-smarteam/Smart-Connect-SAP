import { jest } from '@jest/globals';
import { S4DocumentBusinessPartnerResolver } from '../../../src/infrastructure/sap/customers/S4DocumentBusinessPartnerResolver.js';

const COMPANY_MAPPINGS = [
  { sourceField: 'BusinessPartner', targetField: 'idsap', isActive: true },
  { sourceField: 'BusinessPartnerFullName', targetField: 'name', isActive: true },
  { sourceField: 'to_Customer.BPTaxLongNumber', targetField: 'cedula', isActive: true },
];

const CREATION_CONFIG = {
  findFallbackField: 'to_Customer.BPTaxLongNumber',
  defaults: {
    BusinessPartner: { BusinessPartnerCategory: '2', BusinessPartnerGrouping: 'ZC01' },
    BusinessPartnerRole: ['FLCU00'],
    Customer: { CustomerAccountGroup: 'ZC01' },
    CustomerCompany: { CompanyCode: '1000' },
    CustomerSalesArea: { Currency: 'GTQ' },
  },
};

function buildArgs(overrides = {}) {
  return {
    company: { idsap: '', name: 'ACME S.A.', cedula: '1234567-8' },
    contact: null,
    companyExists: true,
    contactExists: false,
    payload: { deal: { hs_object_id: '77' } },
    context: {
      mappings: { companyMappings: COMPANY_MAPPINGS },
      tenantModels: {},
      hubspotCredentials: { _id: 'cred-1' },
    },
    auditTrail: { payload_SAP: {}, response_SAP: {} },
    salesArea: { salesOrganization: 'MQGT', distributionChannel: '01', division: '00' },
    ...overrides,
  };
}

function buildResolver({ transport, defaultFindSAP = 'BusinessPartner' }) {
  return new S4DocumentBusinessPartnerResolver({
    transport,
    runtimeRepository: {
      resolveDefaultFindSAP: async () => defaultFindSAP,
    },
    salesDocumentConfigRepository: {
      getBusinessPartnerCreationConfig: async () => CREATION_CONFIG,
    },
    hubspotWebhookAdapter: {
      getAccessToken: async () => 'token-1',
      updateBusinessPartnerIds: async () => ({ company: { ok: true } }),
    },
    webhookReferenceRepository: { persistReferences: jest.fn() },
    logger: { warn: jest.fn(), info: jest.fn() },
  });
}

describe('S4DocumentBusinessPartnerResolver', () => {
  it('encuentra el cliente por clave cuando defaultFindSAP es BusinessPartner', async () => {
    const request = jest.fn().mockResolvedValue({ BusinessPartner: '100053' });
    const resolver = buildResolver({ transport: { request } });

    const result = await resolver.findOrCreateForDocument(buildArgs({
      company: { idsap: '100053', name: 'ACME S.A.' },
    }));

    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'get',
      path: "/API_BUSINESS_PARTNER/A_BusinessPartner('100053')",
    }));
    expect(result.cardCode).toBe('100053');
    expect(result.businessPartnerResult.created).toBe(false);
    expect(result.businessPartnerResult.matchedBy).toBe('BusinessPartner');
  });

  // El resolver NO crea contactos en S/4 (D6 del spec): un contacto es otro BusinessPartner
  // con relación BUR001, un segundo deep create que esta entrega no hace.
  it('nunca devuelve ContactEmployees', async () => {
    const resolver = buildResolver({ transport: { request: async () => ({ BusinessPartner: '100053' }) } });

    const result = await resolver.findOrCreateForDocument(buildArgs({
      company: { idsap: '100053', name: 'ACME' },
      contact: { email: 'a@b.com' },
      contactExists: true,
    }));

    expect(result.contactEmployeeResult).toEqual({
      created: false, internalCode: null, internalCodes: [], requestPayload: null,
      responsePayload: null, updateResults: [],
    });
    expect(result.contactEmployeeFailures).toEqual([]);
    expect(result.dealContactIsContactEmployee).toBe(false);
  });

  it('cae al campo de fallback cuando el primario no trae valor', async () => {
    const request = jest.fn().mockResolvedValue([{ BusinessPartner: '100099' }]);
    const resolver = buildResolver({ transport: { request } });

    const result = await resolver.findOrCreateForDocument(buildArgs());

    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'get',
      path: '/API_BUSINESS_PARTNER/A_BusinessPartner',
      query: expect.objectContaining({
        $filter: "to_Customer/BPTaxLongNumber eq '1234567-8'",
        $top: 1,
      }),
    }));
    expect(result.cardCode).toBe('100099');
    expect(result.businessPartnerResult.matchedBy).toBe('to_Customer.BPTaxLongNumber');
  });

  // El 404 de la lectura por clave significa "no existe ese BusinessPartner", no un error del
  // gateway: findByKey lo captura y devuelve null, así que el flujo sigue con el fallback y,
  // si tampoco aparece ahí, con la creación.
  it('trata el 404 de la lectura por clave como "no existe" y sigue al fallback y a la creación', async () => {
    const request = jest.fn()
      .mockRejectedValueOnce({ response: { status: 404 } })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ BusinessPartner: '100200' });
    const resolver = buildResolver({ transport: { request } });

    const result = await resolver.findOrCreateForDocument(buildArgs({
      company: { idsap: '100053', name: 'ACME S.A.', cedula: '1234567-8' },
    }));

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[0][0]).toEqual(expect.objectContaining({
      method: 'get',
      path: "/API_BUSINESS_PARTNER/A_BusinessPartner('100053')",
    }));
    expect(request.mock.calls[1][0]).toEqual(expect.objectContaining({
      method: 'get',
      path: '/API_BUSINESS_PARTNER/A_BusinessPartner',
      query: expect.objectContaining({ $filter: "to_Customer/BPTaxLongNumber eq '1234567-8'" }),
    }));
    expect(request.mock.calls[2][0].method).toBe('post');
    expect(result.cardCode).toBe('100200');
    expect(result.businessPartnerResult.created).toBe(true);
  });

  // La búsqueda primaria puede resolver sin encontrar nada (null por clave, o `[]`
  // por filtro) sin que eso sea un error. El punto de este test es que el fallback se intenta
  // DESPUÉS de una búsqueda primaria real, no que se salte por venir vacío el valor primario
  // (eso ya lo cubre 'cae al campo de fallback cuando el primario no trae valor').
  it('cae al fallback cuando la búsqueda primaria se hizo y no encontró nada (sin 404)', async () => {
    const request = jest.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([{ BusinessPartner: '100099' }]);
    const resolver = buildResolver({ transport: { request } });

    const result = await resolver.findOrCreateForDocument(buildArgs({
      company: { idsap: '100053', name: 'ACME S.A.', cedula: '1234567-8' },
    }));

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][0]).toEqual(expect.objectContaining({
      method: 'get',
      path: "/API_BUSINESS_PARTNER/A_BusinessPartner('100053')",
    }));
    expect(request.mock.calls[1][0]).toEqual(expect.objectContaining({
      method: 'get',
      path: '/API_BUSINESS_PARTNER/A_BusinessPartner',
      query: expect.objectContaining({ $filter: "to_Customer/BPTaxLongNumber eq '1234567-8'" }),
    }));
    expect(result.cardCode).toBe('100099');
    expect(result.businessPartnerResult.matchedBy).toBe('to_Customer.BPTaxLongNumber');
  });

  // Un error que no es 404 (por ejemplo un 500 pasajero del gateway) tiene que propagarse tal
  // cual. Confundirlo con "no existe" crearía un BusinessPartner duplicado cada vez que el
  // gateway falle transitoriamente.
  it('propaga un error que no es 404 en la lectura por clave, sin caer al fallback ni crear', async () => {
    const error = Object.assign(new Error('Internal Server Error'), { response: { status: 500 } });
    const request = jest.fn().mockRejectedValueOnce(error);
    const resolver = buildResolver({ transport: { request } });

    await expect(resolver.findOrCreateForDocument(buildArgs({
      company: { idsap: '100053', name: 'ACME S.A.', cedula: '1234567-8' },
    }))).rejects.toThrow('Internal Server Error');

    expect(request).toHaveBeenCalledTimes(1);
  });

  it('crea el cliente cuando ninguna búsqueda lo encuentra', async () => {
    const request = jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ BusinessPartner: '100100' });
    const resolver = buildResolver({ transport: { request } });

    const result = await resolver.findOrCreateForDocument(buildArgs());

    const createCall = request.mock.calls[1][0];
    expect(createCall.method).toBe('post');
    expect(createCall.path).toBe('/API_BUSINESS_PARTNER/A_BusinessPartner');
    expect(createCall.body).toMatchObject({
      OrganizationBPName1: 'ACME S.A.',
      BusinessPartnerGrouping: 'ZC01',
      to_Customer: {
        to_CustomerSalesArea: [expect.objectContaining({ SalesOrganization: 'MQGT' })],
      },
    });
    expect(result.cardCode).toBe('100100');
    expect(result.businessPartnerResult.created).toBe(true);
  });

  it('escribe el id del cliente de vuelta en HubSpot cuando lo creó', async () => {
    const updateBusinessPartnerIds = jest.fn().mockResolvedValue({ company: { ok: true } });
    const resolver = new S4DocumentBusinessPartnerResolver({
      transport: {
        request: jest.fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce({ BusinessPartner: '100100' }),
      },
      runtimeRepository: { resolveDefaultFindSAP: async () => 'BusinessPartner' },
      salesDocumentConfigRepository: { getBusinessPartnerCreationConfig: async () => CREATION_CONFIG },
      hubspotWebhookAdapter: { getAccessToken: async () => 'token-1', updateBusinessPartnerIds },
      webhookReferenceRepository: { persistReferences: jest.fn() },
      logger: { warn: jest.fn() },
    });

    const result = await resolver.findOrCreateForDocument(buildArgs());

    expect(updateBusinessPartnerIds).toHaveBeenCalledWith(expect.objectContaining({
      cardCode: '100100',
      syncCompany: true,
      syncContact: false,
    }));
    expect(result.hubspotToken).toBe('token-1');
  });

  it('deja el payload y la respuesta de la creación en el audit trail', async () => {
    const resolver = buildResolver({
      transport: {
        request: jest.fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce({ BusinessPartner: '100100' }),
      },
    });
    const args = buildArgs();

    await resolver.findOrCreateForDocument(args);

    expect(args.auditTrail.payload_SAP.businessPartner).toMatchObject({ OrganizationBPName1: 'ACME S.A.' });
    expect(args.auditTrail.response_SAP.businessPartner).toEqual({ BusinessPartner: '100100' });
  });

  // El transporte de S/4 desenvuelve el sobre de OData v2 y entrega el ARRAY PELADO: las
  // fixtures de arriba imitan eso, no la respuesta cruda del gateway. Este test fija las DOS
  // formas que el resolver acepta, para que un cambio futuro del transporte no vuelva a dejar
  // la búsqueda por campo sin encontrar nunca (y creando un cliente duplicado por oferta).
  it('lee la colección tanto del array pelado del transporte como de la forma .value', async () => {
    const bare = jest.fn().mockResolvedValue([{ BusinessPartner: '100099' }]);
    const wrapped = jest.fn().mockResolvedValue({ value: [{ BusinessPartner: '100099' }] });

    for (const request of [bare, wrapped]) {
      const result = await buildResolver({ transport: { request } })
        .findOrCreateForDocument(buildArgs());

      expect(request).toHaveBeenCalledTimes(1);
      expect(result.cardCode).toBe('100099');
      expect(result.businessPartnerResult.created).toBe(false);
    }
  });

  // Un valor con comilla cierra el literal de clave de OData: sin duplicarla el gateway busca
  // otra cosa, responde 404 y el flujo termina creando un cliente duplicado.
  it('duplica la comilla simple en el literal de clave, igual que en el $filter', async () => {
    const request = jest.fn().mockResolvedValue({ BusinessPartner: "O'BRIEN 1" });
    const resolver = buildResolver({ transport: { request } });

    await resolver.findOrCreateForDocument(buildArgs({
      company: { idsap: "O'BRIEN 1", name: 'ACME' },
    }));

    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      path: "/API_BUSINESS_PARTNER/A_BusinessPartner('O''BRIEN%201')",
    }));
  });

  // Con la configuración heredada (defaultFindSAP = 'EmailAddress') el campo primario llega
  // vacío SIEMPRE, y sin búsqueda el flujo se va derecho al alta. El warn es lo único que
  // deja rastro de por qué no se buscó.
  it('avisa cuando el campo de búsqueda primario llega vacío y no emite búsqueda primaria', async () => {
    const warn = jest.fn();
    const request = jest.fn().mockResolvedValueOnce([{ BusinessPartner: '100099' }]);
    const resolver = new S4DocumentBusinessPartnerResolver({
      transport: { request },
      runtimeRepository: { resolveDefaultFindSAP: async () => 'EmailAddress' },
      salesDocumentConfigRepository: { getBusinessPartnerCreationConfig: async () => CREATION_CONFIG },
      hubspotWebhookAdapter: {
        getAccessToken: async () => 'token-1',
        updateBusinessPartnerIds: async () => ({}),
      },
      webhookReferenceRepository: { persistReferences: jest.fn() },
      logger: { warn },
    });

    await resolver.findOrCreateForDocument(buildArgs());

    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ primaryField: 'EmailAddress' }));
    // La única llamada es la del fallback: la primaria no se emitió.
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0].query.$filter).toBe("to_Customer/BPTaxLongNumber eq '1234567-8'");
  });

  it('propaga el error permanente cuando no hay nombre para crear', async () => {
    const resolver = buildResolver({ transport: { request: async () => [] } });

    await expect(resolver.findOrCreateForDocument(buildArgs({
      company: { idsap: '', cedula: '1234567-8' },
    }))).rejects.toThrow(/nombre/i);
  });
});
