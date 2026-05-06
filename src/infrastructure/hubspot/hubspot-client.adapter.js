import * as hubspotClient from '../../services/hubspotClient.js';

export * from '../../services/hubspotClient.js';

export const hubspotClientAdapter = Object.freeze({
  ...hubspotClient,
});

export default hubspotClientAdapter;

