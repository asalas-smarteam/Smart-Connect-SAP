import * as hubspotClient from './hubspotClient.js';

export * from './hubspotClient.js';

export const hubspotClientAdapter = Object.freeze({
  ...hubspotClient,
});

export default hubspotClientAdapter;

