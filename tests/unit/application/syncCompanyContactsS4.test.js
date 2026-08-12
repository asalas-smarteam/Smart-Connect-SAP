import { jest } from '@jest/globals';
import { HandleHubspotAssociations } from '../../../src/application/use-cases/HandleHubspotAssociations.js';

// Focused coverage of the S/4 path added to syncCompanyContacts: it must read
// rawSapData._s4Contacts, map them with the contact mappings, and associate
// each created contact to the company using the person's BusinessPartner id.
function buildHandler({ bypassEmail = true } = {}) {
  const contactHandler = {
    find: jest.fn(async () => null),
    create: jest.fn(async ({ item }) => ({ id: `hs-${item.properties.internalcode}` })),
    update: jest.fn(async () => ({})),
  };
  const associationService = { associateObjectsBySapId: jest.fn(async () => ({})) };
  const associationRegistry = { registerBaseObjectMapping: jest.fn(async () => ({})) };

  const fieldMappingService = {
    // Child contacts are keyed by internalcode, not idsap: idsap is the
    // company-level SAP key, so mapping the person-BP there would make every
    // contact collide with its parent company's identity.
    getMappingsByObjectType: jest.fn(async () => [
      { sourceField: 'BusinessPartner', targetField: 'internalcode', sourceContext: 'contactEmployee' },
    ]),
    // Emulates mapRecords over the person-BPs using the S/4 contact mappings.
    mapRecords: jest.fn(async (records) => records.map((r) => ({
      properties: {
        internalcode: r.BusinessPartner,
        firstname: r.FirstName,
        lastname: r.LastName,
        email: r.to_BusinessPartnerAddress?.[0]?.to_EmailAddress?.[0]?.EmailAddress ?? '',
      },
    }))),
  };

  const syncWarningRepository = { record: jest.fn(async () => ({})) };

  const handler = new HandleHubspotAssociations({
    associationFetcher: { fetch: jest.fn() },
    associationRegistry,
    associationService,
    fieldMappingService,
    contactHandler,
    fallbackEmailGenerator: () => '',
    bypassEmailConfigRepository: { isBypassEmailEnabled: async () => bypassEmail },
    syncWarningRepository,
    logger: { warn: jest.fn(), error: jest.fn() },
  });

  return {
    handler,
    contactHandler,
    associationService,
    associationRegistry,
    fieldMappingService,
    syncWarningRepository,
  };
}

function buildHubspotConflictError(existingId) {
  const error = new Error('HubSpot API request failed: 409 Conflict');
  error.details = {
    endpoint: '/crm/v3/objects/contacts',
    method: 'POST',
    status: 409,
    statusText: 'Conflict',
    hubspotResponse: {
      category: 'CONFLICT',
      status: 'error',
      message: `Contact already exists. Existing ID: ${existingId}`,
    },
  };
  return error;
}

const clientConfig = { hubspotCredentialId: 'cred-1' };
const tenantModels = {};

describe('syncCompanyContacts (S/4 path)', () => {
  it('creates and associates contacts from rawSapData._s4Contacts', async () => {
    const { handler, contactHandler, associationService } = buildHandler();

    const item = {
      rawSapData: {
        BusinessPartner: '100051',
        _s4Contacts: [
          {
            BusinessPartner: '100000',
            FirstName: 'Oscar',
            LastName: 'Rosa',
            to_BusinessPartnerAddress: [{ to_EmailAddress: [{ EmailAddress: 'arosa@acerocibao.com' }] }],
          },
        ],
      },
    };

    await handler.syncCompanyContacts({
      token: 'tok', item, clientConfig, tenantModels, companyHubspotId: 'hs-company-1',
    });

    // Mapped from the person-BP shape.
    expect(contactHandler.create).toHaveBeenCalledWith(expect.objectContaining({
      item: expect.objectContaining({
        properties: expect.objectContaining({
          internalcode: '100000', firstname: 'Oscar', email: 'arosa@acerocibao.com',
        }),
      }),
    }));

    // Associated to the company using the person's BusinessPartner id as sapId.
    expect(associationService.associateObjectsBySapId).toHaveBeenCalledWith(
      'tok', 'cred-1', 'company', 'hs-company-1', 'contact',
      [{ hubspotId: 'hs-100000', sapId: '100000' }],
      tenantModels
    );
  });

  it('creates a contact without email when bypassEmail is on', async () => {
    const { handler, contactHandler } = buildHandler({ bypassEmail: true });

    const item = {
      rawSapData: {
        BusinessPartner: '100052',
        _s4Contacts: [{ BusinessPartner: '100002', FirstName: 'Rafael', LastName: 'Surun' }],
      },
    };

    await handler.syncCompanyContacts({
      token: 'tok', item, clientConfig, tenantModels, companyHubspotId: 'hs-company-2',
    });

    expect(contactHandler.create).toHaveBeenCalledTimes(1);
  });

  it('skips a contact without email when bypassEmail is off', async () => {
    const { handler, contactHandler, associationService } = buildHandler({ bypassEmail: false });

    const item = {
      rawSapData: {
        BusinessPartner: '100052',
        _s4Contacts: [{ BusinessPartner: '100002', FirstName: 'Rafael', LastName: 'Surun' }],
      },
    };

    await handler.syncCompanyContacts({
      token: 'tok', item, clientConfig, tenantModels, companyHubspotId: 'hs-company-2',
    });

    expect(contactHandler.create).not.toHaveBeenCalled();
    expect(associationService.associateObjectsBySapId).not.toHaveBeenCalled();
  });

  it('does nothing when there are no contacts to sync', async () => {
    const { handler, contactHandler } = buildHandler();

    await handler.syncCompanyContacts({
      token: 'tok',
      item: { rawSapData: { BusinessPartner: '100053', _s4Contacts: [] } },
      clientConfig, tenantModels, companyHubspotId: 'hs-3',
    });

    expect(contactHandler.create).not.toHaveBeenCalled();
  });

  it('still reads B1 ContactEmployees when _s4Contacts is absent', async () => {
    const { handler, fieldMappingService } = buildHandler();

    const item = {
      rawSapData: {
        CardCode: 'C100',
        EmailAddress: 'empresa@x.com',
        ContactEmployees: [{ InternalCode: 'CE1', Name: 'Juan', E_Mail: 'juan@x.com' }],
      },
    };

    await handler.syncCompanyContacts({
      token: 'tok', item, clientConfig, tenantModels, companyHubspotId: 'hs-b1',
    });

    // The B1 array was the one mapped (not _s4Contacts).
    expect(fieldMappingService.mapRecords).toHaveBeenCalledWith(
      item.rawSapData.ContactEmployees,
      'cred-1', 'contact', tenantModels, 'contactEmployee'
    );
  });

  it('returns no contact errors when every contact syncs', async () => {
    const { handler } = buildHandler();

    const result = await handler.syncCompanyContacts({
      token: 'tok',
      item: {
        rawSapData: {
          BusinessPartner: '100051',
          _s4Contacts: [{
            BusinessPartner: '100000',
            FirstName: 'Oscar',
            to_BusinessPartnerAddress: [{ to_EmailAddress: [{ EmailAddress: 'a@b.com' }] }],
          }],
        },
      },
      clientConfig, tenantModels, companyHubspotId: 'hs-company-1',
    });

    expect(result).toEqual({ contactErrors: [] });
  });
});

describe('syncCompanyContacts error reporting', () => {
  const twoContacts = {
    rawSapData: {
      BusinessPartner: '110521',
      _s4Contacts: [
        {
          BusinessPartner: '100000',
          FirstName: 'Oscar',
          to_BusinessPartnerAddress: [{ to_EmailAddress: [{ EmailAddress: 'oscar@acme.com' }] }],
        },
        {
          BusinessPartner: '100001',
          FirstName: 'Rafael',
          to_BusinessPartnerAddress: [{ to_EmailAddress: [{ EmailAddress: 'rafael@acme.com' }] }],
        },
      ],
    },
  };

  it('records a HubSpot 409 and keeps syncing the remaining contacts', async () => {
    const { handler, contactHandler, associationService } = buildHandler();
    contactHandler.create.mockImplementationOnce(async () => {
      throw buildHubspotConflictError('238315499166');
    });

    const result = await handler.syncCompanyContacts({
      token: 'tok',
      item: twoContacts,
      clientConfig,
      tenantModels,
      companyHubspotId: 'hs-company-9',
    });

    // The failure of the first contact does not abort the second one.
    expect(contactHandler.create).toHaveBeenCalledTimes(2);
    expect(associationService.associateObjectsBySapId).toHaveBeenCalledWith(
      'tok', 'cred-1', 'company', 'hs-company-9', 'contact',
      [{ hubspotId: 'hs-100001', sapId: '100001' }],
      tenantModels
    );

    expect(result.contactErrors).toHaveLength(1);
    expect(result.contactErrors[0]).toEqual(expect.objectContaining({
      errorType: 'contactEmployee',
      sapContactId: '100000',
      sapCompanyId: '110521',
      hubspotCompanyId: 'hs-company-9',
      endpoint: '/crm/v3/objects/contacts',
      status: 409,
      responseHubspot: expect.objectContaining({
        message: 'Contact already exists. Existing ID: 238315499166',
      }),
    }));
    expect(result.contactErrors[0].payloadHubspot).toEqual(expect.objectContaining({
      internalcode: '100000',
      email: 'oscar@acme.com',
    }));
  });

  it('falls back to the B1 CardCode as the company id in the error entry', async () => {
    const { handler, contactHandler } = buildHandler();
    contactHandler.create.mockImplementationOnce(async () => {
      throw buildHubspotConflictError('999');
    });

    const result = await handler.syncCompanyContacts({
      token: 'tok',
      item: {
        rawSapData: {
          CardCode: 'C100',
          ContactEmployees: [{ InternalCode: 'CE1', Name: 'Juan', E_Mail: 'juan@x.com' }],
        },
      },
      clientConfig,
      tenantModels,
      companyHubspotId: 'hs-b1',
    });

    expect(result.contactErrors[0]).toEqual(expect.objectContaining({
      sapContactId: 'CE1',
      sapCompanyId: 'C100',
    }));
  });

  it('reports a setup failure as a single aggregated entry', async () => {
    const { handler, fieldMappingService } = buildHandler();
    fieldMappingService.mapRecords.mockRejectedValueOnce(new Error('mapping blew up'));

    const result = await handler.syncCompanyContacts({
      token: 'tok',
      item: twoContacts,
      clientConfig,
      tenantModels,
      companyHubspotId: 'hs-company-9',
    });

    expect(result.contactErrors).toEqual([expect.objectContaining({
      errorType: 'contactEmployee',
      sapContactId: null,
      sapCompanyId: '110521',
      message: 'mapping blew up',
    })]);
  });

  it('records a warning when a contact email is bypassed', async () => {
    const { handler, syncWarningRepository } = buildHandler({ bypassEmail: true });

    await handler.syncCompanyContacts({
      token: 'tok',
      item: {
        rawSapData: {
          BusinessPartner: '110521',
          _s4Contacts: [{ BusinessPartner: '100002', FirstName: 'Rafael' }],
        },
      },
      clientConfig,
      tenantModels,
      companyHubspotId: 'hs-company-2',
      syncLogId: 'sync-log-1',
    });

    expect(syncWarningRepository.record).toHaveBeenCalledWith(expect.objectContaining({
      syncLogId: 'sync-log-1',
      objectType: 'contact',
      sapId: '100002',
      code: 'missingEmailBypassed',
      details: expect.objectContaining({
        source: 'companyContact',
        sapCompanyId: '110521',
        hubspotCompanyId: 'hs-company-2',
      }),
    }));
  });

  it('records a warning when a contact is skipped for a missing email', async () => {
    const { handler, syncWarningRepository } = buildHandler({ bypassEmail: false });

    await handler.syncCompanyContacts({
      token: 'tok',
      item: {
        rawSapData: {
          BusinessPartner: '110521',
          _s4Contacts: [{ BusinessPartner: '100002', FirstName: 'Rafael' }],
        },
      },
      clientConfig,
      tenantModels,
      companyHubspotId: 'hs-company-2',
    });

    expect(syncWarningRepository.record).toHaveBeenCalledWith(expect.objectContaining({
      code: 'contactEmailMissingSkipped',
      sapId: '100002',
    }));
  });
});
