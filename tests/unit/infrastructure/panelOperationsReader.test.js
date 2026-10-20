import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import TenantOperationsReader, {
  MAX_FIELD_MAPPINGS,
  eventFilter,
  syncFilter,
} from '../../../src/infrastructure/database/repositories/TenantOperationsReader.js';
import { FieldMappingReaderPort } from '../../../src/application/ports/panel/field-mapping-reader.port.js';
import { assertPort } from '../../../src/application/ports/port-validator.js';

const TENANT = 'sap_integration_acme';
const ID = '6711a0b1c2d3e4f501234567';

function cursor(result) {
  const chain = {
    sort: jest.fn(() => chain),
    skip: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    toArray: jest.fn().mockResolvedValue(result),
  };
  return chain;
}

function fakeConnection(collections) {
  return { db: { collection: jest.fn((name) => collections[name]) } };
}

function build(collections) {
  const connection = fakeConnection(collections);
  const getConnection = jest.fn().mockResolvedValue(connection);
  return { reader: new TenantOperationsReader({ getConnection, maxTimeMS: 1234 }), getConnection, connection };
}

describe('filters', () => {
  it('always hides reports unless a visible status is asked', () => {
    expect(eventFilter({})).toEqual({ status: { $ne: 'report' } });
    expect(eventFilter({ status: 'errored', type: 'createDeal', references: ['5', 5] })).toEqual({
      status: 'errored',
      eventType: 'createDeal',
      'payload.deal.hs_object_id': { $in: ['5', 5] },
    });
  });

  it('uses from inclusive and to exclusive', () => {
    const from = new Date('2026-10-01T00:00:00Z');
    const to = new Date('2026-10-02T00:00:00Z');
    expect(eventFilter({ from, to }).createdAt).toEqual({ $gte: from, $lt: to });
    expect(syncFilter({ from }).startedAt).toEqual({ $gte: from });
  });

  it('maps running to status null and the task to an ObjectId', () => {
    const filter = syncFilter({ hasStatus: true, status: null, taskId: ID });
    expect(filter.status).toBeNull();
    expect(filter.clientConfigId).toEqual(new mongoose.Types.ObjectId(ID));
    expect(syncFilter({})).toEqual({});
  });
});

describe('TenantOperationsReader', () => {
  it('lists events with the list projection, sort, pagination and maxTimeMS', async () => {
    const find = cursor([{ _id: 'e' }]);
    const WebhookEvents = { find: jest.fn(() => find), countDocuments: jest.fn().mockResolvedValue(1) };
    const { reader, connection } = build({ WebhookEvents });

    const result = await reader.listEvents(TENANT, { filters: {}, skip: 25, limit: 25 });

    expect(connection.db.collection).toHaveBeenCalledWith('WebhookEvents');
    const [filter, options] = WebhookEvents.find.mock.calls[0];
    expect(filter).toEqual({ status: { $ne: 'report' } });
    expect(options.maxTimeMS).toBe(1234);
    expect(options.projection).not.toHaveProperty('payload');
    expect(options.projection).not.toHaveProperty('sapAudit');
    expect(options.projection['payload.deal.hs_object_id']).toBe(1);
    expect(find.sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
    expect(find.skip).toHaveBeenCalledWith(25);
    expect(WebhookEvents.countDocuments).toHaveBeenCalledWith(filter, { maxTimeMS: 1234 });
    expect(result).toEqual({ items: [{ _id: 'e' }], total: 1 });
  });

  it('reads payload and audit only with withRaw', async () => {
    const WebhookEvents = { findOne: jest.fn().mockResolvedValue({ _id: ID }) };
    const { reader } = build({ WebhookEvents });

    await reader.findEvent(TENANT, ID);
    await reader.findEvent(TENANT, ID, { withRaw: true });

    expect(WebhookEvents.findOne.mock.calls[0][1].projection).not.toHaveProperty('sapAudit');
    expect(WebhookEvents.findOne.mock.calls[1][1].projection).toEqual(expect.objectContaining({ payload: 1, sapAudit: 1 }));
    expect(WebhookEvents.findOne.mock.calls[1][1].projection).not.toHaveProperty('payload.deal.hs_object_id');
  });

  it('lists syncs without their errors', async () => {
    const find = cursor([]);
    const SyncLogs = { find: jest.fn(() => find), countDocuments: jest.fn().mockResolvedValue(0) };
    const { reader } = build({ SyncLogs });

    await reader.listSyncs(TENANT, { filters: {} });

    const projection = SyncLogs.find.mock.calls[0][1].projection;
    expect(projection).not.toHaveProperty('errors');
    expect(find.sort).toHaveBeenCalledWith({ startedAt: -1, _id: -1 });
  });

  it('pages the errors of a sync with $slice and counts them with $size', async () => {
    const aggregate = { toArray: jest.fn().mockResolvedValue([{ _id: ID, errors: [{ a: 1 }], errorsTotal: 30 }]) };
    const SyncLogs = { aggregate: jest.fn(() => aggregate) };
    const { reader } = build({ SyncLogs });

    const result = await reader.findSync(TENANT, ID, { errorsSkip: 25, errorsLimit: 25 });

    const [pipeline, options] = SyncLogs.aggregate.mock.calls[0];
    expect(pipeline[0]).toEqual({ $match: { _id: new mongoose.Types.ObjectId(ID) } });
    expect(pipeline[1].$project.errors).toEqual({ $slice: [{ $ifNull: ['$errors', []] }, 25, 25] });
    expect(pipeline[1].$project.errorsTotal).toEqual({ $size: { $ifNull: ['$errors', []] } });
    expect(options).toEqual({ maxTimeMS: 1234 });
    expect(result).toEqual({ sync: { _id: ID, errors: [{ a: 1 }] }, errorsTotal: 30 });
  });

  it('reads only the name and type of tasks', async () => {
    const find = cursor([]);
    const ClientConfigs = { find: jest.fn(() => find) };
    const { reader } = build({ ClientConfigs });

    await reader.findTasks(TENANT, [ID, 'basura', ID]);
    await reader.listTasks(TENANT);

    expect(ClientConfigs.find.mock.calls[0][0]).toEqual({ _id: { $in: [new mongoose.Types.ObjectId(ID)] } });
    for (const [, options] of ClientConfigs.find.mock.calls) {
      expect(options.projection).toEqual({ clientName: 1, taskType: 1 });
    }
  });

  it('returns null for malformed ids without connecting', async () => {
    const { reader, getConnection } = build({});

    expect(await reader.findEvent(TENANT, 'x')).toBeNull();
    expect(await reader.findSync(TENANT, { $ne: 1 })).toBeNull();
    expect(await reader.findTasks(TENANT, ['x'])).toEqual([]);
    expect(getConnection).not.toHaveBeenCalled();
  });

  it('turns MaxTimeMSExpired into a panel timeout error', async () => {
    const find = cursor([]);
    find.toArray.mockRejectedValue(Object.assign(new Error('operation exceeded time limit'), { code: 50 }));
    const WebhookEvents = { find: jest.fn(() => find), countDocuments: jest.fn().mockResolvedValue(0) };
    const { reader } = build({ WebhookEvents });

    await expect(reader.listEvents(TENANT, { filters: {} })).rejects.toMatchObject({ code: 'PANEL_QUERY_TIMEOUT' });
  });
});

describe('TenantOperationsReader — plan 5', () => {
  it('filters the event queue runs and the empty ones', () => {
    expect(syncFilter({ eventQueue: true, hideEmpty: true })).toEqual({ clientConfigId: null, recordsProcessed: { $gt: 0 } });
  });

  it('reads summary events with a minimal projection, a cut error text and detects the cap', async () => {
    const aggregate = { toArray: jest.fn().mockResolvedValue([{ _id: 1 }, { _id: 2 }, { _id: 3 }]) };
    const WebhookEvents = { aggregate: jest.fn(() => aggregate) };
    const { reader } = build({ WebhookEvents });
    const from = new Date('2026-10-01T00:00:00Z');
    const to = new Date('2026-10-02T00:00:00Z');

    const result = await reader.listEventsForSummary(TENANT, { from, to, limit: 2 });

    const [pipeline, options] = WebhookEvents.aggregate.mock.calls[0];
    expect(pipeline[0]).toEqual({ $match: { createdAt: { $gte: from, $lt: to }, status: { $ne: 'report' } } });
    expect(pipeline[1]).toEqual({ $limit: 3 });
    const project = pipeline[2].$project;
    expect(Object.keys(project).sort()).toEqual([
      'createdAt', 'lastError', 'payload.deal.dealname', 'payload.deal.hs_object_id', 'sapAudit.responseSap.DocNum', 'status', 'updatedAt',
    ]);
    expect(JSON.stringify(project.lastError)).toContain('$substrCP');
    expect(options).toEqual({ maxTimeMS: 1234 });
    expect(result).toEqual({ items: [{ _id: 1 }, { _id: 2 }], truncated: true });
  });
});

describe('TenantOperationsReader — queue event ids (plan 5b)', () => {
  it('finds errored events of those deals in the window, reading only id and reference', async () => {
    const find = cursor([{ _id: { toString: () => 'e1' }, payload: { deal: { hs_object_id: 111 } } }]);
    const WebhookEvents = { find: jest.fn(() => find) };
    const { reader } = build({ WebhookEvents });
    const from = new Date('2026-10-12T09:59:00Z');
    const to = new Date('2026-10-12T10:01:30Z');

    const result = await reader.findQueueEventIds(TENANT, { references: ['111', 'ABC', '111'], from, to });

    const [filter, options] = WebhookEvents.find.mock.calls[0];
    expect(filter).toEqual({ status: 'errored', 'payload.deal.hs_object_id': { $in: ['111', 111, 'ABC'] }, updatedAt: { $gte: from, $lte: to } });
    expect(options).toEqual({ projection: { 'payload.deal.hs_object_id': 1 }, maxTimeMS: 1234 });
    expect(result).toEqual([{ id: 'e1', reference: '111' }]);
  });

  it('does not query without references', async () => {
    const { reader, getConnection } = build({});
    expect(await reader.findQueueEventIds(TENANT, { references: [], from: new Date(), to: new Date() })).toEqual([]);
    expect(getConnection).not.toHaveBeenCalled();
  });
});

describe('TenantOperationsReader — exchange projection (plan 5c)', () => {
  it('reads payload, sent and response for the detail, never sapCalls, without path collisions', async () => {
    const WebhookEvents = { findOne: jest.fn().mockResolvedValue({ _id: ID }) };
    const { reader } = build({ WebhookEvents });

    await reader.findEvent(TENANT, ID, { withExchange: true });

    const projection = WebhookEvents.findOne.mock.calls[0][1].projection;
    expect(projection).toEqual(expect.objectContaining({ payload: 1, 'sapAudit.payloadSap': 1, 'sapAudit.responseSap': 1 }));
    expect(projection).not.toHaveProperty('sapAudit');
    expect(projection).not.toHaveProperty('sapAudit.sapCalls');
    expect(projection).not.toHaveProperty('payload.deal.hs_object_id');
  });
});

describe('TenantOperationsReader — field mappings (plan 6)', () => {
  it('implements the field mapping reader port', () => {
    expect(() => assertPort(new TenantOperationsReader(), FieldMappingReaderPort)).not.toThrow();
  });

  it('reads every mapping with only the view fields, sorted, with maxTimeMS and the cap', async () => {
    const docs = [{ _id: 'a', sourceField: 'ItemCode' }];
    const find = cursor(docs);
    const FieldMappings = { find: jest.fn(() => find) };
    const { reader, connection } = build({ FieldMappings });

    const result = await reader.listFieldMappings(TENANT);

    expect(connection.db.collection).toHaveBeenCalledWith('FieldMappings');
    const [filter, options] = FieldMappings.find.mock.calls[0];
    expect(filter).toEqual({});
    expect(options.maxTimeMS).toBe(1234);
    expect(options.projection).toEqual({
      sourceField: 1,
      targetField: 1,
      objectType: 1,
      sourceContext: 1,
      isActive: 1,
      editable: 1,
      includeInServiceLayerSelect: 1,
      userField: 1,
    });
    expect(options.projection).not.toHaveProperty('clientConfigId');
    expect(options.projection).not.toHaveProperty('hubspotCredentialId');
    expect(find.sort).toHaveBeenCalledWith({ objectType: 1, sourceContext: 1, sourceField: 1, _id: 1 });
    expect(find.limit).toHaveBeenCalledWith(MAX_FIELD_MAPPINGS + 1);
    expect(result).toEqual({ items: docs, truncated: false });
  });

  it('cuts the list at the cap and says so', async () => {
    const docs = Array.from({ length: MAX_FIELD_MAPPINGS + 1 }, (_, index) => ({ _id: String(index) }));
    const FieldMappings = { find: jest.fn(() => cursor(docs)) };
    const { reader } = build({ FieldMappings });

    const result = await reader.listFieldMappings(TENANT);

    expect(result.items).toHaveLength(MAX_FIELD_MAPPINGS);
    expect(result.truncated).toBe(true);
  });

  it('turns MaxTimeMSExpired into a panel timeout error', async () => {
    const find = cursor([]);
    find.toArray.mockRejectedValue(Object.assign(new Error('operation exceeded time limit'), { code: 50 }));
    const { reader } = build({ FieldMappings: { find: jest.fn(() => find) } });

    await expect(reader.listFieldMappings(TENANT)).rejects.toMatchObject({ code: 'PANEL_QUERY_TIMEOUT' });
  });
});
