import { jest } from '@jest/globals';

const mockAxios = jest.fn();

jest.unstable_mockModule('axios', () => ({
  default: mockAxios,
}));

jest.unstable_mockModule('../../../src/infrastructure/logger/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const { S4GatewayTransport } = await import(
  '../../../src/infrastructure/sap/transport/S4GatewayTransport.js'
);

const config = {
  serviceLayerBaseUrl: 'https://s4.example.com:44300/',
  serviceLayerUsername: 'INTEGRATION',
  serviceLayerPassword: 'secret',
};

describe('S4GatewayTransport', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requires serviceLayerBaseUrl', () => {
    expect(() => new S4GatewayTransport({ config: {} })).toThrow(
      'serviceLayerBaseUrl is required'
    );
  });

  it('builds GET urls with the gateway prefix, basic auth and $format=json', async () => {
    mockAxios.mockResolvedValueOnce({
      data: { d: { results: [{ BusinessPartner: '10000' }] } },
      headers: {},
    });

    const transport = new S4GatewayTransport({ config });
    const result = await transport.request({
      path: '/API_BUSINESS_PARTNER/A_BusinessPartner',
      query: { $top: 2 },
    });

    expect(mockAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://s4.example.com:44300/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner?$top=2&$format=json',
        auth: { username: 'INTEGRATION', password: 'secret' },
      })
    );
    expect(result).toEqual([{ BusinessPartner: '10000' }]);
  });

  it('uses /sap/-rooted paths verbatim (catalog service)', async () => {
    mockAxios.mockResolvedValueOnce({ data: { d: { results: [] } }, headers: {} });

    const transport = new S4GatewayTransport({ config });
    await transport.request({
      path: '/sap/opu/odata/iwfnd/catalogservice;v=2/ServiceCollection',
    });

    expect(mockAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://s4.example.com:44300/sap/opu/odata/iwfnd/catalogservice;v=2/ServiceCollection?$format=json',
      })
    );
  });

  it('normalizes dates and strips metadata in responses', async () => {
    mockAxios.mockResolvedValueOnce({
      data: {
        d: {
          __metadata: { uri: 'x' },
          BusinessPartner: '10000',
          CreationDate: '/Date(1659571200000)/',
          CreationTime: 'PT20H40M35S',
        },
      },
      headers: {},
    });

    const transport = new S4GatewayTransport({ config });
    const result = await transport.request({
      path: "/API_BUSINESS_PARTNER/A_BusinessPartner('10000')",
    });

    expect(result).toEqual({
      BusinessPartner: '10000',
      CreationDate: '2022-08-04T00:00:00.000Z',
      CreationTime: '20:40:35',
    });
  });

  it('follows __next links across pages in fetchAll', async () => {
    mockAxios
      .mockResolvedValueOnce({
        data: {
          d: {
            results: [{ BusinessPartner: '10000' }],
            __next: 'https://s4.example.com:44300/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner?$skiptoken=1&$format=json',
          },
        },
        headers: {},
      })
      .mockResolvedValueOnce({
        data: { d: { results: [{ BusinessPartner: '10001' }] } },
        headers: {},
      });

    const transport = new S4GatewayTransport({ config });
    const result = await transport.fetchAll({
      path: '/API_BUSINESS_PARTNER/A_BusinessPartner',
      query: { $select: 'BusinessPartner' },
    });

    expect(result).toEqual([
      { BusinessPartner: '10000' },
      { BusinessPartner: '10001' },
    ]);
    expect(mockAxios).toHaveBeenCalledTimes(2);
    expect(mockAxios.mock.calls[1][0].url).toBe(
      'https://s4.example.com:44300/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner?$skiptoken=1&$format=json'
    );
  });

  it('fetches a CSRF token before writes and sends it with the session cookie', async () => {
    mockAxios
      // CSRF fetch on the service document
      .mockResolvedValueOnce({
        data: {},
        headers: {
          'x-csrf-token': 'token-abc',
          'set-cookie': ['SAP_SESSIONID=xyz; path=/', 'sap-usercontext=uc; path=/'],
        },
      })
      // Actual write
      .mockResolvedValueOnce({
        data: { d: { BusinessPartner: '10002' } },
        headers: {},
      });

    const transport = new S4GatewayTransport({ config });
    const result = await transport.request({
      method: 'post',
      path: '/API_BUSINESS_PARTNER/A_BusinessPartner',
      body: { BusinessPartnerCategory: '2' },
    });

    expect(mockAxios.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        method: 'get',
        url: 'https://s4.example.com:44300/sap/opu/odata/sap/API_BUSINESS_PARTNER/?$format=json',
        headers: { 'x-csrf-token': 'Fetch' },
      })
    );
    expect(mockAxios.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        method: 'post',
        headers: expect.objectContaining({
          'x-csrf-token': 'token-abc',
          Cookie: 'SAP_SESSIONID=xyz; sap-usercontext=uc',
        }),
      })
    );
    expect(result).toEqual({ BusinessPartner: '10002' });
  });

  it('refreshes the CSRF token once when the gateway rejects it', async () => {
    const csrfRejection = new Error('CSRF token validation failed');
    csrfRejection.response = {
      status: 403,
      headers: { 'x-csrf-token': 'Required' },
    };

    mockAxios
      // initial CSRF fetch
      .mockResolvedValueOnce({
        data: {},
        headers: { 'x-csrf-token': 'stale-token', 'set-cookie': [] },
      })
      // write rejected
      .mockRejectedValueOnce(csrfRejection)
      // refreshed CSRF fetch
      .mockResolvedValueOnce({
        data: {},
        headers: { 'x-csrf-token': 'fresh-token', 'set-cookie': [] },
      })
      // retried write
      .mockResolvedValueOnce({ data: { d: { ok: true } }, headers: {} });

    const transport = new S4GatewayTransport({ config });
    const result = await transport.request({
      method: 'post',
      path: '/API_BUSINESS_PARTNER/A_BusinessPartner',
      body: {},
    });

    expect(result).toEqual({ ok: true });
    expect(mockAxios).toHaveBeenCalledTimes(4);
    expect(mockAxios.mock.calls[3][0].headers).toEqual(
      expect.objectContaining({ 'x-csrf-token': 'fresh-token' })
    );
  });

  it('propagates non-CSRF errors without retrying', async () => {
    const serverError = new Error('boom');
    serverError.response = { status: 500, headers: {} };

    mockAxios
      .mockResolvedValueOnce({
        data: {},
        headers: { 'x-csrf-token': 'token', 'set-cookie': [] },
      })
      .mockRejectedValueOnce(serverError);

    const transport = new S4GatewayTransport({ config });

    await expect(
      transport.request({ method: 'post', path: '/API_BUSINESS_PARTNER/A_BusinessPartner', body: {} })
    ).rejects.toThrow('boom');
    expect(mockAxios).toHaveBeenCalledTimes(2);
  });
});

describe('S4GatewayTransport credential params', () => {
  const BASE = 'https://s4.example.com:44300/sap/opu/odata/sap';
  const withParams = (params) => ({ ...config, params });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('appends credential params to buildUrl', () => {
    const transport = new S4GatewayTransport({ config: withParams({ 'sap-client': '600' }) });

    expect(transport.buildUrl('/API_BUSINESS_PARTNER/A_BusinessPartner', { $top: 2 })).toBe(
      `${BASE}/API_BUSINESS_PARTNER/A_BusinessPartner?$top=2&$format=json&sap-client=600`
    );
  });

  it('lets a caller-supplied key win over the credential param', () => {
    const transport = new S4GatewayTransport({ config: withParams({ 'sap-client': '600' }) });

    expect(transport.buildUrl('/SVC/Entity', { 'sap-client': '100' })).toBe(
      `${BASE}/SVC/Entity?sap-client=100&$format=json`
    );
  });

  it('URL-encodes credential param keys and values', () => {
    const transport = new S4GatewayTransport({ config: withParams({ 'sap-language': 'E S&x=1' }) });

    expect(transport.buildUrl('/SVC/Entity')).toBe(
      `${BASE}/SVC/Entity?$format=json&sap-language=E%20S%26x%3D1`
    );
  });

  it('keeps URLs identical to the legacy shape when params are empty or absent', () => {
    const expected = `${BASE}/SVC/Entity?$top=2&$format=json`;

    expect(new S4GatewayTransport({ config }).buildUrl('/SVC/Entity', { $top: 2 })).toBe(expected);
    expect(
      new S4GatewayTransport({ config: withParams({}) }).buildUrl('/SVC/Entity', { $top: 2 })
    ).toBe(expected);
  });

  it('ignores malformed params without throwing', () => {
    const expected = `${BASE}/SVC/Entity?$format=json&sap-client=600`;

    expect(
      new S4GatewayTransport({ config: withParams('sap-client=600') }).buildUrl('/SVC/Entity')
    ).toBe(`${BASE}/SVC/Entity?$format=json`);
    expect(
      new S4GatewayTransport({ config: withParams(['a', 'b']) }).buildUrl('/SVC/Entity')
    ).toBe(`${BASE}/SVC/Entity?$format=json`);
    expect(
      new S4GatewayTransport({
        config: withParams({ 'sap-client': '600', nested: { a: 1 }, nothing: null, '': 'x' }),
      }).buildUrl('/SVC/Entity')
    ).toBe(expected);
  });

  it('sends credential params on the CSRF fetch GET', async () => {
    mockAxios
      .mockResolvedValueOnce({
        data: {},
        headers: { 'x-csrf-token': 'token-abc', 'set-cookie': [] },
      })
      .mockResolvedValueOnce({ data: { d: { BusinessPartner: '10002' } }, headers: {} });

    const transport = new S4GatewayTransport({ config: withParams({ 'sap-client': '600' }) });
    await transport.request({ method: 'post', path: '/API_BUSINESS_PARTNER/A_BusinessPartner', body: {} });

    expect(mockAxios.mock.calls[0][0].url).toBe(
      `${BASE}/API_BUSINESS_PARTNER/?$format=json&sap-client=600`
    );
    // The write itself carries no $format (the gateway rejects system query options on writes).
    expect(mockAxios.mock.calls[1][0].url).toBe(
      `${BASE}/API_BUSINESS_PARTNER/A_BusinessPartner?sap-client=600`
    );
  });

  it('merges a missing credential param into __next links and keeps the rest untouched', async () => {
    mockAxios
      .mockResolvedValueOnce({
        data: { d: { results: [{ A: 1 }], __next: `${BASE}/SVC/Entity?$skiptoken=1&$format=json` } },
        headers: {},
      })
      .mockResolvedValueOnce({ data: { d: { results: [{ A: 2 }] } }, headers: {} });

    const transport = new S4GatewayTransport({ config: withParams({ 'sap-client': '600' }) });
    await transport.fetchAll({ path: '/SVC/Entity' });

    expect(mockAxios.mock.calls[1][0].url).toBe(
      `${BASE}/SVC/Entity?$skiptoken=1&$format=json&sap-client=600`
    );
  });

  it('does not duplicate a credential param already present in __next', async () => {
    const next = `${BASE}/SVC/Entity?$skiptoken=1&sap-client=600&$format=json`;
    mockAxios
      .mockResolvedValueOnce({
        data: { d: { results: [{ A: 1 }], __next: next } },
        headers: {},
      })
      .mockResolvedValueOnce({ data: { d: { results: [{ A: 2 }] } }, headers: {} });

    const transport = new S4GatewayTransport({ config: withParams({ 'sap-client': '600' }) });
    await transport.fetchAll({ path: '/SVC/Entity' });

    expect(mockAxios.mock.calls[1][0].url).toBe(next);
  });

  it('keeps everything after a second "?" in a __next link when merging params', async () => {
    const next = `${BASE}/SVC/Entity?$filter=Name eq 'a?b'&$skiptoken=1&$format=json`;
    mockAxios
      .mockResolvedValueOnce({
        data: { d: { results: [{ A: 1 }], __next: next } },
        headers: {},
      })
      .mockResolvedValueOnce({ data: { d: { results: [{ A: 2 }] } }, headers: {} });

    const transport = new S4GatewayTransport({ config: withParams({ 'sap-client': '600' }) });
    await transport.fetchAll({ path: '/SVC/Entity' });

    expect(mockAxios.mock.calls[1][0].url).toBe(`${next}&sap-client=600`);
  });

  it('drops blank values and $-prefixed keys coming from the stored params', () => {
    const transport = new S4GatewayTransport({
      config: withParams({
        'sap-client': '   ',
        'sap-language': '',
        $top: '1',
        'sap-lang': 'E',
      }),
    });

    expect(transport.buildUrl('/SVC/Entity')).toBe(`${BASE}/SVC/Entity?$format=json&sap-lang=E`);
  });
});

// The Gateway answers 400 "SystemQueryOptions not allowed for this request type" when a write
// carries `$format`, so writes ask for JSON through the Accept header instead.
describe('S4GatewayTransport write requests', () => {
  const BASE = 'https://s4.example.com:44300/sap/opu/odata/sap';
  const csrfResponse = { data: {}, headers: { 'x-csrf-token': 'token-abc', 'set-cookie': [] } };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each(['post', 'patch', 'put', 'delete'])(
    'sends no $format on %s and asks for JSON through the Accept header',
    async (method) => {
      mockAxios
        .mockResolvedValueOnce(csrfResponse)
        .mockResolvedValueOnce({ data: { d: { ok: true } }, headers: {} });

      const transport = new S4GatewayTransport({ config });
      await transport.request({ method, path: '/SVC/Entity', body: {} });

      const write = mockAxios.mock.calls[1][0];
      expect(write.url).toBe(`${BASE}/SVC/Entity`);
      expect(write.headers).toEqual(
        expect.objectContaining({ Accept: 'application/json', 'x-csrf-token': 'token-abc' })
      );
    }
  );

  it('keeps the credential params on a write but still sends no $format', async () => {
    mockAxios
      .mockResolvedValueOnce(csrfResponse)
      .mockResolvedValueOnce({ data: { d: { ok: true } }, headers: {} });

    const transport = new S4GatewayTransport({
      config: { ...config, params: { 'sap-client': '600' } },
    });
    await transport.request({ method: 'post', path: '/SVC/Entity', body: {} });

    expect(mockAxios.mock.calls[1][0].url).toBe(`${BASE}/SVC/Entity?sap-client=600`);
  });

  it('keeps the caller query options on a write, without adding $format', async () => {
    mockAxios
      .mockResolvedValueOnce(csrfResponse)
      .mockResolvedValueOnce({ data: { d: { ok: true } }, headers: {} });

    const transport = new S4GatewayTransport({ config });
    await transport.request({ method: 'post', path: '/SVC/Entity', query: { $expand: 'to_Item' }, body: {} });

    expect(mockAxios.mock.calls[1][0].url).toBe(`${BASE}/SVC/Entity?$expand=to_Item`);
  });

  it('lets a caller-supplied Accept header win on a write', async () => {
    mockAxios
      .mockResolvedValueOnce(csrfResponse)
      .mockResolvedValueOnce({ data: { d: { ok: true } }, headers: {} });

    const transport = new S4GatewayTransport({ config });
    await transport.request({
      method: 'post',
      path: '/SVC/Entity',
      body: {},
      headers: { Accept: 'application/atom+xml' },
    });

    expect(mockAxios.mock.calls[1][0].headers.Accept).toBe('application/atom+xml');
  });

  it('keeps $format=json on the CSRF fetch GET that precedes a write', async () => {
    mockAxios
      .mockResolvedValueOnce(csrfResponse)
      .mockResolvedValueOnce({ data: { d: { ok: true } }, headers: {} });

    const transport = new S4GatewayTransport({ config });
    await transport.request({ method: 'post', path: '/SVC/Entity', body: {} });

    expect(mockAxios.mock.calls[0][0].url).toBe(`${BASE}/SVC/?$format=json`);
  });
});
