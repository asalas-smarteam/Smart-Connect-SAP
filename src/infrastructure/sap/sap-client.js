import serviceLayerService from '../../services/serviceLayer.service.js';
import sapService from '../../integrations/sap/sapService.js';

export { serviceLayerService, sapService };

export const sapClient = Object.freeze({
  fetchData: sapService.fetchData,
  executeServiceLayerRequest: serviceLayerService.execute,
});

export default sapClient;

