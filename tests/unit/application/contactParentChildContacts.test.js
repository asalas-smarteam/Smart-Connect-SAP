import { jest } from '@jest/globals';
import HandleHubspotAssociations from '../../../src/application/use-cases/HandleHubspotAssociations.js';

function buildHandler() {
  const associateObjectsBySapId = jest.fn().mockResolvedValue({ ok: true });
  const handler = new HandleHubspotAssociations({
    associationFetcher: { fetch: jest.fn().mockResolvedValue(null) },
    associationService: {
      associateObjectsBySapId,
      associateContactWithCompanies: jest.fn().mockResolvedValue({ ok: true }),
      associateCompanyWithContacts: jest.fn().mockResolvedValue({ ok: true }),
    },
    associationRegistry: {
      findHubspotIdForSapId: jest.fn().mockResolvedValue(null),
      registerBaseObjectMapping: jest.fn().mockResolvedValue(undefined),
    },
    fieldMappingService: {
      getMappingsByObjectType: jest.fn().mockResolvedValue([
        { sourceField: 'Name', targetField: 'firstname', isActive: true },
      ]),
      mapRecords: jest.fn().mockResolvedValue([{ properties: { firstname: 'Ana', email: 'ana@x.com' } }]),
    },
    contactHandler: {
      find: jest.fn().mockResolvedValue({ id: '900' }),
      update: jest.fn().mockResolvedValue({ id: '900' }),
      create: jest.fn().mockResolvedValue({ id: '900' }),
    },
    fallbackEmailGenerator: (parentEmail, sapId) => `sap-${sapId}@example.com`,
    bypassEmailConfigRepository: { getBypassEmail: jest.fn().mockResolvedValue(false) },
    syncWarningRepository: { record: jest.fn().mockResolvedValue(null) },
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });

  return { handler, associateObjectsBySapId };
}

const CLIENT_CONFIG = { hubspotCredentialId: 'cred1', id: 'cfg1', associationFetchEnabled: false };

describe('padre contacto -> contactos hijo', () => {
  it('handleContactAssociations sincroniza los ContactEmployees', async () => {
    const { handler, associateObjectsBySapId } = buildHandler();
    const item = {
      properties: { idsap: 'C1' },
      rawSapData: { CardCode: 'C1', ContactEmployees: [{ InternalCode: 11, Name: 'Ana', E_Mail: 'ana@x.com' }] },
    };

    await handler.execute({
      objectType: 'contact', token: 'tok', item, clientConfig: CLIENT_CONFIG,
      tenantModels: {}, hubspotId: '100', syncLogId: 'log1',
    });

    expect(associateObjectsBySapId).toHaveBeenCalledWith(
      'tok', 'cred1', 'contact', '100', 'contact',
      [{ hubspotId: '900', sapId: 11 }],
      {}
    );
  });

  it('el padre company sigue asociando company -> contact', async () => {
    const { handler, associateObjectsBySapId } = buildHandler();
    const item = {
      properties: { idsap: 'C1' },
      rawSapData: { CardCode: 'C1', ContactEmployees: [{ InternalCode: 11, Name: 'Ana', E_Mail: 'ana@x.com' }] },
    };

    await handler.execute({
      objectType: 'company', token: 'tok', item, clientConfig: CLIENT_CONFIG,
      tenantModels: {}, hubspotId: '100', syncLogId: 'log1',
    });

    expect(associateObjectsBySapId).toHaveBeenCalledWith(
      'tok', 'cred1', 'company', '100', 'contact',
      [{ hubspotId: '900', sapId: 11 }],
      {}
    );
  });

  // GUARDA DE AUTO-ASOCIACION: caso nuevo, imposible con un padre company.
  it('descarta el par cuando el hijo resuelve al mismo contacto que el padre', async () => {
    const { handler, associateObjectsBySapId } = buildHandler();
    handler.contactHandler.find = jest.fn().mockResolvedValue({ id: '100' }); // el mismo id del padre

    const item = {
      properties: { idsap: 'C1' },
      rawSapData: { CardCode: 'C1', ContactEmployees: [{ InternalCode: 11, Name: 'Ana', E_Mail: 'ana@x.com' }] },
    };

    await handler.execute({
      objectType: 'contact', token: 'tok', item, clientConfig: CLIENT_CONFIG,
      tenantModels: {}, hubspotId: '100', syncLogId: 'log1',
    });

    expect(associateObjectsBySapId).not.toHaveBeenCalled();
    expect(handler.logger.warn).toHaveBeenCalled();
  });

  it('sin ContactEmployees no toca HubSpot', async () => {
    const { handler, associateObjectsBySapId } = buildHandler();

    await handler.execute({
      objectType: 'contact', token: 'tok',
      item: { properties: { idsap: 'C1' }, rawSapData: { CardCode: 'C1' } },
      clientConfig: CLIENT_CONFIG, tenantModels: {}, hubspotId: '100', syncLogId: 'log1',
    });

    expect(associateObjectsBySapId).not.toHaveBeenCalled();
  });
});
