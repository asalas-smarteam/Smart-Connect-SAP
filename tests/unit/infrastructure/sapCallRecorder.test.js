import { jest } from '@jest/globals';
import { createSapCallRecorder } from '#infrastructure/sap/sapCallRecorder.js';

function buildAdapter(impl) {
  return {
    request: jest.fn(impl),
    async createOrder({ sapConfig, orderPayload }) {
      return this.request(sapConfig, { method: 'post', path: '/Orders', data: orderPayload });
    },
  };
}

describe('createSapCallRecorder', () => {
  it('records a successful call with its method, path and bodies', async () => {
    const recorder = createSapCallRecorder();
    const adapter = recorder.wrap(buildAdapter(async () => ({ DocEntry: 10 })));

    const response = await adapter.createOrder({
      sapConfig: {},
      orderPayload: { CardCode: 'CL001' },
    });

    expect(response).toEqual({ DocEntry: 10 });
    expect(recorder.calls).toEqual([
      expect.objectContaining({
        method: 'POST',
        path: '/Orders',
        request: { CardCode: 'CL001' },
        response: { DocEntry: 10 },
        ok: true,
      }),
    ]);
  });

  it('records the failing call and rethrows the original error untouched', async () => {
    const sapError = Object.assign(new Error('Request failed with status code 400'), {
      response: { status: 400, data: { error: { message: { value: 'SP - ERROR' } } } },
    });
    const recorder = createSapCallRecorder();
    const adapter = recorder.wrap(buildAdapter(async () => { throw sapError; }));

    await expect(
      adapter.createOrder({ sapConfig: {}, orderPayload: { CardCode: 'CL001' } })
    ).rejects.toBe(sapError);

    expect(recorder.calls).toEqual([
      expect.objectContaining({
        method: 'POST',
        path: '/Orders',
        request: { CardCode: 'CL001' },
        ok: false,
        status: 400,
        error: sapError,
      }),
    ]);
  });

  it('records GET params so the SAP search that ran is visible too', async () => {
    const recorder = createSapCallRecorder();
    const adapter = recorder.wrap(buildAdapter(async () => ({ value: [] })));

    await adapter.request({}, {
      method: 'get',
      path: '/BusinessPartners',
      params: { $filter: "EmailAddress eq 'a@b.com'" },
    });

    expect(recorder.calls[0]).toMatchObject({
      method: 'GET',
      params: { $filter: "EmailAddress eq 'a@b.com'" },
      request: null,
    });
  });

  it('stops growing past maxCalls and counts what it dropped', async () => {
    const recorder = createSapCallRecorder({ maxCalls: 2 });
    const adapter = recorder.wrap(buildAdapter(async () => ({})));

    for (let index = 0; index < 5; index += 1) {
      await adapter.request({}, { method: 'get', path: `/Items('${index}')` });
    }

    expect(recorder.calls).toHaveLength(2);
    expect(recorder.droppedCalls).toBe(3);
  });

  // El adapter envuelto no puede perder ningun metodo: los use cases lo usan para todo,
  // no solo para las llamadas que se auditan.
  it('keeps every other method of the wrapped adapter reachable', async () => {
    const recorder = createSapCallRecorder();
    const base = buildAdapter(async () => ({}));
    base.somethingElse = () => 'ok';

    const wrapped = recorder.wrap(base);

    expect(wrapped.somethingElse()).toBe('ok');
    expect(wrapped.request).not.toBe(base.request);
  });

  it('returns the adapter untouched when it has no request method to intercept', () => {
    const recorder = createSapCallRecorder();
    const fake = { findOrCreateBusinessPartner: jest.fn() };

    expect(recorder.wrap(fake)).toBe(fake);
  });
});
