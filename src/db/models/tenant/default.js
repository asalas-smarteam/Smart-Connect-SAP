import mongoose from 'mongoose';
import { registerTenantModels } from './index.js';

const tenantModels = registerTenantModels(mongoose.connection);

export default tenantModels;
