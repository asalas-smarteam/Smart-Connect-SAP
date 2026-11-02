import { buildGatewayAuthHeaders } from '../../../src/infrastructure/sap/serviceLayerGatewayHeaders.js';

describe('buildGatewayAuthHeaders', () => {
  it('returns a Bearer Authorization header when the token is set', () => {
    expect(buildGatewayAuthHeaders({ serviceLayerGatewayToken: 'test-gateway-token' })).toEqual({
      Authorization: 'Bearer test-gateway-token',
    });
  });

  it('trims the token', () => {
    expect(buildGatewayAuthHeaders({ serviceLayerGatewayToken: '  test-gateway-token \n' })).toEqual({
      Authorization: 'Bearer test-gateway-token',
    });
  });

  it.each([
    ['empty', { serviceLayerGatewayToken: '' }],
    ['blank', { serviceLayerGatewayToken: '   ' }],
    ['null', { serviceLayerGatewayToken: null }],
    ['undefined', { serviceLayerGatewayToken: undefined }],
    ['missing', {}],
    ['a non-string value', { serviceLayerGatewayToken: 42 }],
  ])('returns an empty object when the token is %s', (_label, config) => {
    expect(buildGatewayAuthHeaders(config)).toEqual({});
  });

  it('returns an empty object when the config itself is missing', () => {
    expect(buildGatewayAuthHeaders(undefined)).toEqual({});
    expect(buildGatewayAuthHeaders(null)).toEqual({});
  });
});
