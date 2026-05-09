import serviceLayerService from './serviceLayer.service.js';
import sapService from './sapService.js';

export { serviceLayerService, sapService };

export const sapClient = Object.freeze({
  fetchData: sapService.fetchData,
  executeServiceLayerRequest: serviceLayerService.execute,
});

export default sapClient;

