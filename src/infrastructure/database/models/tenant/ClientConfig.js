import mongoose from 'mongoose';
import { SAP_FILTER_OPERATORS } from '#domain/sap/sap-filter.constants.js';
import {
  CLIENT_CONFIG_TASK_TYPE_VALUES,
  DEFAULT_CLIENT_CONFIG_TASK_TYPE,
} from '#domain/sync/dropdown-options.constants.js';
import {
  EXECUTION_TIME_PATTERN,
  MAX_EXECUTION_TIMES,
} from '#domain/sync/execution-times.js';

const { Schema } = mongoose;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const EXECUTION_DAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

const clientFilterSchema = new Schema(
  {
    operator: {
      type: String,
      enum: SAP_FILTER_OPERATORS,
      required: true,
    },
    property: {
      type: String,
      required: true,
    },
    value: {
      type: Schema.Types.Mixed,
      default: null,
    },
    isDefault: {
      type: Boolean,
      default: false,
    },
    isDynamic: {
      type: Boolean,
      default: false,
    },
    dynamicType: {
      type: String,
      enum: ['datetime', 'date', 'time'],
      default: 'datetime',
    },
    editable: {
      type: Boolean,
      default: true,
    },
  },
  { _id: false }
);

const clientOrderBySchema = new Schema(
  {
    property: {
      type: String,
      required: true,
    },
    direction: {
      type: String,
      enum: ['asc', 'desc'],
      default: 'desc',
    },
  },
  { _id: false }
);

export const clientConfigSchema = new Schema(
  {
    clientName: {
      type: String,
    },
    // What this scheduled task does. SAP_SYNC is the record pipeline and stays
    // the default so existing documents keep their behavior. DROPDOWN_OPTIONS
    // only rewrites HubSpot enumeration options: it ignores serviceLayerPath,
    // objectType, filters, orderBy and mode, because what to read comes from the
    // `dropdownOptionsSync` configuration and where to write it comes from the
    // fieldMappings.
    taskType: {
      type: String,
      enum: CLIENT_CONFIG_TASK_TYPE_VALUES,
      default: DEFAULT_CLIENT_CONFIG_TASK_TYPE,
    },
    integrationModeId: {
      type: Schema.Types.ObjectId,
      ref: 'IntegrationMode',
    },
    apiUrl: {
      type: String,
    },
    apiToken: {
      type: String,
    },
    serviceLayerPath: {
      type: String,
    },
    storeProcedureName: {
      type: String,
    },
    sqlQuery: {
      type: String,
    },
    mode: {
      type: String,
      enum: ['FULL', 'INCREMENTAL'],
      required: true,
      default: 'INCREMENTAL',
    },
    intervalMinutes: {
      type: Number,
      default: null,
    },
    // Array de horas 'HH:mm'. Antes era un String único; Mongoose envuelve solo un escalar tanto al
    // asignar como al hidratar, así que los documentos viejos que guardan "01:00" se siguen leyendo
    // como ['01:00'] sin migrar. Ojo: .lean() NO castea, ahí llega el string crudo -- por eso el
    // scheduler normaliza al leer.
    executionTime: {
      type: [String],
      default: [],
      validate: {
        validator(value) {
          if (value === null || value === undefined) {
            return true;
          }

          if (!Array.isArray(value) || value.length > MAX_EXECUTION_TIMES) {
            return false;
          }

          return value.every((entry) => EXECUTION_TIME_PATTERN.test(String(entry ?? '').trim()));
        },
        message: `executionTime must use HH:mm format and have at most ${MAX_EXECUTION_TIMES} entries`,
      },
    },
    executionDays: {
      type: [String],
      enum: EXECUTION_DAYS,
      default: [],
    },
    startTime: {
      type: String,
      default: null,
      validate: {
        validator(value) {
          return value === null || value === '' || TIME_PATTERN.test(value);
        },
        message: 'startTime must use HH:mm format',
      },
    },
    endTime: {
      type: String,
      default: null,
      validate: {
        validator(value) {
          return value === null || value === '' || TIME_PATTERN.test(value);
        },
        message: 'endTime must use HH:mm format',
      },
    },
    externalDbHost: {
      type: String,
    },
    externalDbPort: {
      type: Number,
    },
    externalDbUser: {
      type: String,
    },
    externalDbPassword: {
      type: String,
    },
    externalDbName: {
      type: String,
    },
    externalDbDialect: {
      type: String,
    },
    associationFetchEnabled: {
      type: Boolean,
      default: false,
    },
    associationFetchConfig: {
      type: Schema.Types.Mixed,
      default: null,
    },
    hubspotCredentialId: {
      type: Schema.Types.ObjectId,
      ref: 'HubspotCredentials',
      default: null,
    },
    hubspotBatchSize: {
      type: Number,
      default: 1,
    },
    objectType: {
      type: String,
      default: null,
    },
    filters: {
      type: [clientFilterSchema],
      default: [],
    },
    orderBy: {
      type: [clientOrderBySchema],
      default: [],
    },
    active: {
      type: Boolean,
      default: false,
    },
    lastRun: {
      type: Date,
    },
    lastError: {
      type: String,
    },
    requireUpdateHubspotID: {
      type: Boolean,
      default: false,
    },
    updateMethod: {
      type: String,
    },
    updateSpName: {
      type: String,
    },
    updateTableName: {
      type: String,
    },
  },
  {
    timestamps: false,
    collection: 'ClientConfigs',
  }
);

clientConfigSchema.pre('validate', function validateIncrementalWindow(next) {
  if (this.mode !== 'INCREMENTAL') {
    next();
    return;
  }

  const hasStartTime = Boolean(this.startTime);
  const hasEndTime = Boolean(this.endTime);
  if (hasStartTime === hasEndTime) {
    next();
    return;
  }

  next(new Error('startTime and endTime must be provided together'));
});

export function createClientConfigModel(connection) {
  return connection.models.ClientConfig || connection.model('ClientConfig', clientConfigSchema);
}
