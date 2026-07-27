import { jest } from '@jest/globals';

jest.unstable_mockModule('../../../src/infrastructure/sap/sapSessionManager.js', () => ({
  default: {
    getSessionCookie: jest.fn(),
    resolveTenantKey: jest.fn(),
    invalidateSession: jest.fn(),
  },
  isSessionInvalidError: () => false,
}));

jest.unstable_mockModule('axios', () => ({
  default: jest.fn(),
}));

jest.unstable_mockModule('../../../src/infrastructure/logger/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { createSapTransport } = await import(
  '../../../src/infrastructure/sap/transport/sapTransportFactory.js'
);
const { B1ServiceLayerTransport } = await import(
  '../../../src/infrastructure/sap/transport/B1ServiceLayerTransport.js'
);
const { S4GatewayTransport } = await import(
  '../../../src/infrastructure/sap/transport/S4GatewayTransport.js'
);

const config = {
  serviceLayerBaseUrl: 'https://sap.example.com',
  serviceLayerUsername: 'user',
  serviceLayerPassword: 'pass',
};

describe('createSapTransport', () => {
  it('resolves S4 to the Gateway transport', () => {
    expect(createSapTransport({ sapFlavor: 'S4', config })).toBeInstanceOf(S4GatewayTransport);
    expect(createSapTransport({ sapFlavor: ' s4 ', config })).toBeInstanceOf(S4GatewayTransport);
  });

  it('resolves B1 to the Service Layer transport', () => {
    expect(createSapTransport({ sapFlavor: 'B1', config })).toBeInstanceOf(B1ServiceLayerTransport);
  });

  it('falls back to B1 for absent or unknown flavors', () => {
    expect(createSapTransport({ config })).toBeInstanceOf(B1ServiceLayerTransport);
    expect(createSapTransport({ sapFlavor: 'HANA', config })).toBeInstanceOf(B1ServiceLayerTransport);
  });
});
