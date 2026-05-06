import mongoose from 'mongoose';
import env from '#infrastructure/config/env.js';
import FeatureFlags from '../models/global/FeatureFlags.js';
import GlobalAuditLog from '../models/global/GlobalAuditLog.js';
import PaymentStatus from '../models/global/PaymentStatus.js';
import Plan from '../models/global/Plan.js';
import SaaSClient from '../models/global/SaaSClient.js';
import Subscription from '../models/global/Subscription.js';

const { MONGODB_URI } = env;

let connecting;

async function connect() {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  if (connecting) {
    await connecting;
    return mongoose.connection;
  }

  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI is not defined');
  }

  connecting = mongoose.connect(MONGODB_URI);
  await connecting;
  connecting = undefined;
  console.info('Database connected');
  return mongoose.connection;
}

async function disconnect() {
  if (mongoose.connection.readyState === 0) {
    return;
  }
  await mongoose.disconnect();
}

const database = mongoose.connection;

export {
  database,
  connect,
  disconnect,
  SaaSClient,
  Subscription,
  Plan,
  PaymentStatus,
  GlobalAuditLog,
  FeatureFlags,
};

export default {
  database,
  connect,
  disconnect,
  SaaSClient,
  Subscription,
  Plan,
  PaymentStatus,
  GlobalAuditLog,
  FeatureFlags,
};
