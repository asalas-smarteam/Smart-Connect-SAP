import { jest } from '@jest/globals';

const mockFindCompanyByEmail = jest.fn();
const mockFindCompanyByProperty = jest.fn();
const mockUpdateCompany = jest.fn();

jest.unstable_mockModule('../../src/infrastructure/hubspot/hubspotClient.js', () => ({
  findCompanyByEmail: mockFindCompanyByEmail,
  findCompanyByProperty: mockFindCompanyByProperty,
  updateCompany: mockUpdateCompany,
  createCompany: jest.fn(),
}));

const { find, update, buildBatchUpdateEntry } = await import('../../src/infrastructure/hubspot/handlers/company.handler.js');

describe('company.handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const searchProperties = ['email', 'name', 'phone', 'idsap', 'idSap'];
  const configModels = (value) => ({
    Configuration: {
      findOne: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ key: 'defaultFindHubspot', value }) }),
    },
  });

  it('searches by idsap first and stops there when it exists', async () => {
    mockFindCompanyByProperty.mockResolvedValueOnce({ id: 'hs-1', properties: { idsap: 'C004' } });
    const tenantModels = configModels('phone');

    const existing = await find({
      token: 'token-1',
      tenantModels,
      item: { properties: { idsap: 'C004', phone: '+50527741100', email: '' } },
    });

    expect(existing).toEqual({ id: 'hs-1', properties: { idsap: 'C004' } });
    expect(mockFindCompanyByProperty).toHaveBeenCalledTimes(1);
    expect(mockFindCompanyByProperty).toHaveBeenCalledWith('token-1', 'idsap', 'C004', { properties: searchProperties });
    // Found by idsap: the configured property is never even read.
    expect(tenantModels.Configuration.findOne).not.toHaveBeenCalled();
    expect(mockFindCompanyByEmail).not.toHaveBeenCalled();
  });

  it('falls back to defaultFindHubspot (phone) only when idsap does not exist', async () => {
    mockFindCompanyByProperty
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'hs-lead', properties: { phone: '+50527741100' } });

    const existing = await find({
      token: 'token-1',
      tenantModels: configModels('phone'),
      item: { properties: { idsap: 'C004', phone: '+50527741100', email: '' } },
    });

    expect(existing).toEqual({ id: 'hs-lead', properties: { phone: '+50527741100' } });
    expect(mockFindCompanyByProperty).toHaveBeenNthCalledWith(2, 'token-1', 'phone', '+50527741100', {
      properties: searchProperties,
      withoutProperties: ['idsap'],
    });
  });

  it('without defaultFindHubspot config the second lookup is email, limited to records not owned by SAP', async () => {
    mockFindCompanyByProperty.mockResolvedValue(null);

    await find({
      token: 'token-1',
      item: { properties: { email: 'x@example.com' } },
    });

    expect(mockFindCompanyByProperty).toHaveBeenCalledTimes(1);
    expect(mockFindCompanyByProperty).toHaveBeenCalledWith('token-1', 'email', 'x@example.com', {
      properties: searchProperties,
      withoutProperties: ['idsap'],
    });
  });

  it('returns null when the second lookup lands on a record owned by another idsap', async () => {
    mockFindCompanyByProperty
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'hs-other', properties: { idsap: 'OTHER', phone: '+50527741100' } });

    const existing = await find({
      token: 'token-1',
      tenantModels: configModels('phone'),
      item: { properties: { idsap: 'C004', phone: '+50527741100' } },
    });

    expect(existing).toBeNull();
  });

  it('returns null without a second lookup when the item has neither idsap nor the configured value', async () => {
    const existing = await find({
      token: 'token-1',
      tenantModels: configModels('phone'),
      item: { properties: { email: '' } },
    });

    expect(existing).toBeNull();
    expect(mockFindCompanyByProperty).not.toHaveBeenCalled();
  });

  it('updates only SAP identifier when key fields changed', async () => {
    mockUpdateCompany.mockResolvedValue({ id: 'hs-company-1' });

    await update({
      token: 'token-1',
      id: 'hs-company-1',
      existing: {
        id: 'hs-company-1',
        properties: {
          name: 'Old Company',
          phone: '8888',
          idsap: 'C-01',
        },
      },
      item: {
        properties: {
          name: 'New Company',
          phone: '8888',
          idsap: 'C-01',
          email: 'company@example.com',
        },
      },
    });

    expect(mockUpdateCompany).toHaveBeenCalledWith('token-1', 'hs-company-1', {
      properties: {
        idsap: 'C-01',
      },
    });
  });

  it('skips update when key fields did not change', async () => {
    const existing = {
      id: 'hs-company-1',
      properties: {
        name: 'Same Company',
        phone: '8888',
        idsap: 'C-01',
      },
    };

    const result = await update({
      token: 'token-1',
      id: 'hs-company-1',
      existing,
      item: {
        properties: {
          name: 'Same Company',
          phone: '8888',
          idsap: 'C-01',
          email: 'company@example.com',
        },
      },
    });

    expect(result).toBe(existing);
    expect(mockUpdateCompany).not.toHaveBeenCalled();
  });
});

describe('company.handler buildBatchUpdateEntry', () => {
  it('returns null when the identifier-only payload is empty', () => {
    expect(buildBatchUpdateEntry({
      existing: { id: 'hs-1', properties: { name: 'Acme' } },
      item: { properties: { name: 'Acme' } },
    })).toBeNull();
  });

  it('returns null when key fields are unchanged', () => {
    expect(buildBatchUpdateEntry({
      existing: { id: 'hs-1', properties: { name: 'Acme', phone: '1', idsap: 'C001' } },
      item: { properties: { name: 'Acme', phone: '1', idsap: 'C001' } },
    })).toBeNull();
  });

  it('returns an id + identifier payload when key fields changed', () => {
    expect(buildBatchUpdateEntry({
      existing: { id: 'hs-1', properties: { name: 'Old', idsap: 'C001' } },
      item: { properties: { name: 'New', idsap: 'C001' } },
    })).toEqual({ id: 'hs-1', properties: { idsap: 'C001' } });
  });
});

// La forma exacta que el tenant escribe en Configurations.
const UPDATE_FIELDS_CONFIG = {
  company: ['u_subgrupo', 'mobile_phone', 'cardcurrency', 'phone'],
  contact: ['firstname'],
};

function tenantModelsWith(value) {
  return {
    Configuration: {
      findOne: jest.fn(() => ({
        lean: async () => (value ? { key: 'hubspotUpdateFields', value } : null),
      })),
    },
  };
}

// El registro real de un tenant: name, phone e idsap IGUALES a los de HubSpot,
// y lo que cambió es un campo de negocio que el gate viejo no miraba.
const EXISTING = {
  id: 'hs-company-1',
  properties: {
    name: 'Alejandro Salas Smarteam',
    phone: '+50259877130',
    idsap: 'CLO061771',
    u_subgrupo: 'COMERCIAL',
    cardcurrency: 'USD',
  },
};

const INCOMING = {
  properties: {
    name: 'Alejandro Salas Smarteam',
    phone: '+50259877130',
    idsap: 'CLO061771',
    email: 'mgomez@grupoprinter.com',
    u_subgrupo: 'LEGAL',
    mobile_phone: '30291217',
    cardcurrency: 'USD',
    nit: '0011391703-1',
  },
};

describe('company.handler — hubspotUpdateFields', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('manda las propiedades configuradas además del idsap', async () => {
    await update({
      token: 'token-1',
      id: 'hs-company-1',
      existing: EXISTING,
      item: INCOMING,
      tenantModels: tenantModelsWith(UPDATE_FIELDS_CONFIG),
    });

    expect(mockUpdateCompany).toHaveBeenCalledWith('token-1', 'hs-company-1', {
      properties: {
        idsap: 'CLO061771',
        u_subgrupo: 'LEGAL',
        mobile_phone: '30291217',
        cardcurrency: 'USD',
        phone: '+50259877130',
      },
    });
  });

  it('no manda lo que NO está en la lista', async () => {
    await update({
      token: 'token-1',
      id: 'hs-company-1',
      existing: EXISTING,
      item: INCOMING,
      tenantModels: tenantModelsWith(UPDATE_FIELDS_CONFIG),
    });

    const [, , payload] = mockUpdateCompany.mock.calls[0];
    // `nit` y `email` están mapeados y llegaron en properties, pero el tenant no
    // los autorizó: pisarlos borraría lo que el asesor escribió en HubSpot.
    expect(payload.properties).not.toHaveProperty('nit');
    expect(payload.properties).not.toHaveProperty('email');
    expect(payload.properties).not.toHaveProperty('name');
  });

  it('actualiza aunque name, phone e idsap sean idénticos', async () => {
    // Este es el caso reportado: sin la config el gate devolvía false porque solo
    // miraba esos tres campos, y el cambio de u_subgrupo no salía nunca.
    const result = await update({
      token: 'token-1',
      id: 'hs-company-1',
      existing: EXISTING,
      item: INCOMING,
      tenantModels: tenantModelsWith(UPDATE_FIELDS_CONFIG),
    });

    expect(mockUpdateCompany).toHaveBeenCalled();
    expect(result).not.toBe(EXISTING);
  });

  it('sigue salteando cuando tampoco cambió ningún campo configurado', async () => {
    const existing = { id: 'hs-company-1', properties: { ...INCOMING.properties } };

    const result = await update({
      token: 'token-1',
      id: 'hs-company-1',
      existing,
      item: INCOMING,
      tenantModels: tenantModelsWith(UPDATE_FIELDS_CONFIG),
    });

    expect(result).toBe(existing);
    expect(mockUpdateCompany).not.toHaveBeenCalled();
  });

  it('omite un campo configurado que viene vacío de SAP', async () => {
    // Blanquear en HubSpot un dato que el asesor cargó a mano, porque en SAP
    // nadie lo llenó, es pérdida de dato que nadie detecta.
    await update({
      token: 'token-1',
      id: 'hs-company-1',
      existing: EXISTING,
      item: {
        properties: {
          ...INCOMING.properties,
          mobile_phone: '',
          cardcurrency: null,
        },
      },
      tenantModels: tenantModelsWith(UPDATE_FIELDS_CONFIG),
    });

    const [, , payload] = mockUpdateCompany.mock.calls[0];
    expect(payload.properties).not.toHaveProperty('mobile_phone');
    expect(payload.properties).not.toHaveProperty('cardcurrency');
    expect(payload.properties.u_subgrupo).toBe('LEGAL');
  });

  it('sin documento de config se comporta como antes', async () => {
    const result = await update({
      token: 'token-1',
      id: 'hs-company-1',
      existing: EXISTING,
      item: INCOMING,
      tenantModels: tenantModelsWith(null),
    });

    expect(result).toBe(EXISTING);
    expect(mockUpdateCompany).not.toHaveBeenCalled();
  });

  it('no toma la lista del contact', async () => {
    await update({
      token: 'token-1',
      id: 'hs-company-1',
      existing: EXISTING,
      item: INCOMING,
      tenantModels: tenantModelsWith({ contact: ['u_subgrupo'] }),
    });

    expect(mockUpdateCompany).not.toHaveBeenCalled();
  });

  it('updateFields explícito gana y no lee la config', async () => {
    // Es lo que hacen los caminos batch: una lectura por corrida, no por item.
    const tenantModels = tenantModelsWith(UPDATE_FIELDS_CONFIG);

    await update({
      token: 'token-1',
      id: 'hs-company-1',
      existing: EXISTING,
      item: INCOMING,
      tenantModels,
      updateFields: ['u_subgrupo'],
    });

    expect(tenantModels.Configuration.findOne).not.toHaveBeenCalled();
    expect(mockUpdateCompany).toHaveBeenCalledWith('token-1', 'hs-company-1', {
      properties: { idsap: 'CLO061771', u_subgrupo: 'LEGAL' },
    });
  });

  it('buildBatchUpdateEntry aplica la misma lista', async () => {
    expect(buildBatchUpdateEntry({
      existing: EXISTING,
      item: INCOMING,
      updateFields: ['u_subgrupo', 'mobile_phone'],
    })).toEqual({
      id: 'hs-company-1',
      properties: { idsap: 'CLO061771', u_subgrupo: 'LEGAL', mobile_phone: '30291217' },
    });

    // Sin lista, el batch sigue siendo identifier-only y este caso se saltea.
    expect(buildBatchUpdateEntry({ existing: EXISTING, item: INCOMING })).toBeNull();
  });

  it('actualiza un registro sin idsap si trae un campo configurado', async () => {
    // Sin esto la config no serviría para los registros que todavía no tienen
    // el identificador escrito en HubSpot.
    await update({
      token: 'token-1',
      id: 'hs-company-1',
      existing: { id: 'hs-company-1', properties: { u_subgrupo: 'COMERCIAL' } },
      item: { properties: { u_subgrupo: 'LEGAL' } },
      updateFields: ['u_subgrupo'],
    });

    expect(mockUpdateCompany).toHaveBeenCalledWith('token-1', 'hs-company-1', {
      properties: { u_subgrupo: 'LEGAL' },
    });
  });
});
