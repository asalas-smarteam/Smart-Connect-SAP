import { SAP_FLAVORS } from '#domain/sap/sap-flavor.constants.js';
import { DROPDOWN_WARNING_CODES } from '#domain/sync/dropdown-options.constants.js';
import {
  classifyTargetProperty,
  extractOptionSets,
  mergePropertyOptions,
  propertyOptionsAreEqual,
  validateHubspotPropertyName,
} from '#domain/sync/dropdown-options.service.js';

function emptyMetrics() {
  return {
    recordsProcessed: 0,
    hubspotSent: 0,
    hubspotFailed: 0,
    hubspotCreated: 0,
    hubspotUpdated: 0,
    dropdown: {
      sourcesProcessed: 0,
      sourcesFailed: 0,
      optionsFetched: 0,
      propertiesUpdated: 0,
      propertiesUnchanged: 0,
      propertiesSkipped: 0,
      warnings: 0,
    },
  };
}

// Rewrites the option list of HubSpot enumeration ("dropdown") properties from
// SAP master data. It never reads or writes a CRM record: the only thing it
// touches is property metadata, which is why it is a separate use case from
// SyncSapConfigToHubspot rather than a mode of it.
//
// The contract with the job wrapper is deliberately identical to
// SyncSapConfigToHubspot: same execute() signature, same { ok, status, metrics }
// result, so sap-sync.job.js can route between them without special casing.
export class SyncDropdownOptionsToHubspot {
  constructor({
    dropdownConfigRepository,
    dropdownCatalog,
    dropdownTargetRepository,
    hubspotPropertyGateway,
    hubspotCredentialRepository,
    hubspotTokenProvider,
    clientConfigRepository,
    syncLogRepository,
    syncWarningRepository,
    sapFlavorRepository,
    logger = console,
    dateProvider = () => new Date(),
  }) {
    this.dropdownConfigRepository = dropdownConfigRepository;
    this.dropdownCatalog = dropdownCatalog;
    this.dropdownTargetRepository = dropdownTargetRepository;
    this.hubspotPropertyGateway = hubspotPropertyGateway;
    this.hubspotCredentialRepository = hubspotCredentialRepository;
    this.hubspotTokenProvider = hubspotTokenProvider;
    this.clientConfigRepository = clientConfigRepository;
    this.syncLogRepository = syncLogRepository;
    this.syncWarningRepository = syncWarningRepository;
    this.sapFlavorRepository = sapFlavorRepository;
    this.logger = logger;
    this.dateProvider = dateProvider;
  }

  async execute({ config = null, configId = null, tenantContext }) {
    const startedAt = this.dateProvider();
    let activeConfig = config;
    const clientConfigId = configId ?? activeConfig?.id ?? activeConfig?._id ?? null;
    let syncLog = null;
    const metrics = emptyMetrics();

    try {
      if (!activeConfig && clientConfigId) {
        activeConfig = await this.clientConfigRepository.findById({
          tenantContext,
          configId: clientConfigId,
        });
      }

      syncLog = await this.syncLogRepository.start({
        tenantContext,
        clientConfigId,
        // SyncLog.objectType is an enum of record types; a dropdown run spans
        // several object types at once, so it stays null.
        objectType: null,
        startedAt,
      });

      if (!activeConfig) {
        throw new Error('Client configuration not found');
      }

      const context = {
        tenantContext,
        clientConfigId,
        syncLogId: syncLog?.id ?? syncLog?._id ?? null,
        metrics,
      };

      const flavor = await this.resolveSapFlavor(tenantContext);
      if (flavor !== SAP_FLAVORS.B1) {
        return this.finish({
          ...context,
          status: 'errored',
          errorMessage: `Dropdown option sync is only supported on SAP B1; tenant sapFlavor is '${flavor}'`,
          warning: {
            code: DROPDOWN_WARNING_CODES.UNSUPPORTED_SAP_FLAVOR,
            message: 'Dropdown option sync ran on a non-B1 tenant and was skipped',
            details: { sapFlavor: flavor },
          },
        });
      }

      const dropdownConfig = await this.dropdownConfigRepository.getDropdownOptionsConfig({
        tenantContext,
      });

      if (!dropdownConfig.enabled) {
        this.logger.info?.({
          msg: 'Dropdown option sync skipped: not enabled for this tenant',
          tenantKey: tenantContext?.tenantKey ?? null,
          clientConfigId: String(clientConfigId ?? ''),
        });

        return this.finish({ ...context, status: 'completed' });
      }

      // Presence is checked here to fail fast, but the token itself is resolved
      // after the SAP reads: a stored accessToken may already be expired, and
      // resolving late keeps it as fresh as possible for the writes.
      const credentials = await this.hubspotCredentialRepository.findByClientConfig({
        tenantContext,
        clientConfig: activeConfig,
      });

      if (!credentials) {
        return this.finish({
          ...context,
          status: 'errored',
          errorMessage: 'No HubSpot credentials assigned to this clientConfig',
        });
      }

      for (const invalidSource of dropdownConfig.invalidSources) {
        await this.recordWarning({
          ...context,
          code: DROPDOWN_WARNING_CODES.INVALID_SOURCE,
          message: `Ignored ${invalidSource.id}: ${invalidSource.error}`,
          details: invalidSource,
        });
      }

      const optionSetsByField = await this.collectOptionSets({
        ...context,
        sources: dropdownConfig.sources,
      });

      let accessToken = null;

      try {
        accessToken = await this.resolveAccessToken({
          tenantContext,
          clientConfig: activeConfig,
          credentials,
        });
      } catch (error) {
        return this.finish({
          ...context,
          status: 'errored',
          errorMessage: `Could not obtain a valid HubSpot access token: ${error.message}`,
        });
      }

      await this.applyOptionSets({
        ...context,
        optionSetsByField,
        accessToken,
        hubspotCredentialId: activeConfig.hubspotCredentialId,
      });

      return this.finish({ ...context, status: 'completed' });
    } catch (error) {
      this.logger.error?.({
        msg: 'Dropdown option sync failed',
        tenantKey: tenantContext?.tenantKey ?? null,
        clientConfigId: String(clientConfigId ?? ''),
        error: error.message,
      });

      return this.finish({
        tenantContext,
        clientConfigId,
        syncLogId: syncLog?.id ?? syncLog?._id ?? null,
        metrics,
        status: 'errored',
        errorMessage: error.message,
      });
    }
  }

  // OAuth access tokens live ~30 minutes, so the value stored on the credential
  // document is routinely stale. hubspotAuthService.getAccessToken returns it
  // when still valid and refreshes it with the refreshToken when not, persisting
  // the new one -- the same provider every other HubSpot flow uses.
  async resolveAccessToken({ tenantContext, clientConfig, credentials }) {
    if (typeof this.hubspotTokenProvider?.getAccessToken !== 'function') {
      if (!credentials?.accessToken) {
        throw new Error('no token provider configured and the credential has no accessToken');
      }

      return credentials.accessToken;
    }

    const token = await this.hubspotTokenProvider.getAccessToken(
      credentials?._id ?? clientConfig?.hubspotCredentialId,
      credentials,
      tenantContext?.tenantModels
    );

    if (!token) {
      throw new Error('the token provider returned no access token');
    }

    return token;
  }

  async resolveSapFlavor(tenantContext) {
    if (typeof this.sapFlavorRepository?.resolveSapFlavor !== 'function') {
      return SAP_FLAVORS.B1;
    }

    return this.sapFlavorRepository.resolveSapFlavor({
      tenantModels: tenantContext?.tenantModels,
    });
  }

  // Fetches every source and turns its rows into option lists keyed by SAP
  // field. The first source that claims a field wins: two sources feeding the
  // same field would otherwise overwrite each other on every run, so the
  // conflict is reported instead of silently alternating.
  async collectOptionSets({ sources, ...context }) {
    const optionSetsByField = new Map();

    for (const source of sources) {
      let rows = null;

      try {
        rows = await this.dropdownCatalog.fetchRows({
          tenantContext: context.tenantContext,
          serviceLayerPath: source.serviceLayerPath,
          query: source.query,
        });
      } catch (error) {
        context.metrics.dropdown.sourcesFailed += 1;
        await this.recordWarning({
          ...context,
          code: DROPDOWN_WARNING_CODES.SOURCE_FETCH_FAILED,
          message: `Could not read ${source.serviceLayerPath} from SAP: ${error.message}`,
          details: { source: source.id, serviceLayerPath: source.serviceLayerPath, query: source.query },
        });
        continue;
      }

      context.metrics.dropdown.sourcesProcessed += 1;

      // Paired with the optionCount on the 'resolved to' line further down: a
      // short dropdown is otherwise ambiguous between "SAP only gave us page
      // one" and "the rows arrived and extraction discarded most of them".
      this.logger.info?.({
        msg: 'Dropdown source rows fetched',
        tenantKey: context.tenantContext?.tenantKey ?? null,
        source: source.id,
        serviceLayerPath: source.serviceLayerPath,
        query: source.query,
        rowCount: Array.isArray(rows) ? rows.length : 0,
      });

      const { optionSets, issues } = extractOptionSets({ source, rows });

      for (const issue of issues) {
        await this.recordWarning({
          ...context,
          code: issue.code,
          message: issue.message,
          details: { ...(issue.details ?? {}), field: issue.field },
        });
      }

      for (const optionSet of optionSets) {
        const existing = optionSetsByField.get(optionSet.field);

        if (existing) {
          await this.recordWarning({
            ...context,
            code: DROPDOWN_WARNING_CODES.TARGET_CONFLICT,
            message: `${optionSet.field} is fed by more than one source; kept the options from ${existing.sourceId} and ignored ${source.id}`,
            details: { field: optionSet.field, kept: existing.sourceId, ignored: source.id },
          });
          continue;
        }

        context.metrics.dropdown.optionsFetched += optionSet.options.length;
        optionSetsByField.set(optionSet.field, {
          options: optionSet.options,
          sourceId: source.id,
          serviceLayerPath: source.serviceLayerPath,
        });
      }
    }

    return optionSetsByField;
  }

  async applyOptionSets({ optionSetsByField, accessToken, hubspotCredentialId, ...context }) {
    const fields = [...optionSetsByField.keys()];

    if (fields.length === 0) {
      return;
    }

    const targets = await this.dropdownTargetRepository.findTargetsBySourceFields({
      tenantContext: context.tenantContext,
      hubspotCredentialId,
      sourceFields: fields,
    });
    const targetsByField = targets.reduce((accumulator, target) => {
      const list = accumulator.get(target.sourceField) ?? [];
      list.push(target);
      accumulator.set(target.sourceField, list);
      return accumulator;
    }, new Map());

    for (const field of fields) {
      const fieldTargets = targetsByField.get(field) ?? [];

      if (fieldTargets.length === 0) {
        context.metrics.dropdown.propertiesSkipped += 1;
        await this.recordWarning({
          ...context,
          code: DROPDOWN_WARNING_CODES.FIELD_WITHOUT_MAPPING,
          message: `${field} has no active fieldMapping for this HubSpot credential, so there is no property to write its options to`,
          details: { field, source: optionSetsByField.get(field)?.sourceId ?? null },
        });
        continue;
      }

      // Without this line a field mapped on some object types but not others is
      // invisible: FIELD_WITHOUT_MAPPING only fires when a field has no mapping
      // at all, so the object types nobody mapped leave no trace whatsoever.
      this.logger.info?.({
        msg: 'Dropdown field resolved to HubSpot properties',
        tenantKey: context.tenantContext?.tenantKey ?? null,
        sapField: field,
        optionCount: optionSetsByField.get(field)?.options?.length ?? 0,
        targets: fieldTargets.map((target) => `${target.objectType}.${target.targetField}`),
      });

      for (const target of fieldTargets) {
        await this.applyOptionSetToTarget({
          ...context,
          accessToken,
          field,
          target,
          optionSet: optionSetsByField.get(field),
        });
      }
    }
  }

  async applyOptionSetToTarget({ accessToken, field, target, optionSet, ...context }) {
    context.metrics.recordsProcessed += 1;
    const { objectType, targetField } = target;
    const nameCheck = validateHubspotPropertyName(targetField);

    if (!nameCheck.valid) {
      context.metrics.dropdown.propertiesSkipped += 1;
      await this.recordWarning({
        ...context,
        objectType,
        code: DROPDOWN_WARNING_CODES.PROPERTY_NAME_INVALID,
        message: `${objectType}.${targetField} skipped: ${nameCheck.reason}`,
        details: {
          field,
          objectType,
          targetField,
          suggestedTargetField: String(targetField ?? '').trim().toLowerCase() || null,
        },
      });
      return;
    }

    let property = null;

    try {
      property = await this.hubspotPropertyGateway.findProperty({
        accessToken,
        objectType,
        propertyName: targetField,
      });
    } catch (error) {
      context.metrics.hubspotFailed += 1;
      await this.recordWarning({
        ...context,
        objectType,
        code: DROPDOWN_WARNING_CODES.PROPERTY_UPDATE_FAILED,
        message: `Could not read property ${objectType}.${targetField} from HubSpot: ${error.message}`,
        details: { field, objectType, targetField },
      });
      return;
    }

    const classification = classifyTargetProperty(property);

    if (!classification.writable) {
      context.metrics.dropdown.propertiesSkipped += 1;
      await this.recordWarning({
        ...context,
        objectType,
        code: classification.code,
        message: `${objectType}.${targetField} skipped: ${classification.message}`,
        details: {
          field,
          objectType,
          targetField,
          propertyType: property?.type ?? null,
          source: optionSet?.sourceId ?? null,
        },
      });
      return;
    }

    const { options, summary } = mergePropertyOptions({
      existingOptions: property.options,
      sapOptions: optionSet.options,
    });

    if (propertyOptionsAreEqual(property.options, options)) {
      context.metrics.dropdown.propertiesUnchanged += 1;
      // Logged rather than skipped in silence: "already correct" and "never
      // attempted" are indistinguishable otherwise, and that ambiguity is
      // exactly what makes a missing dropdown hard to diagnose.
      this.logger.info?.({
        msg: 'Dropdown property options already up to date',
        tenantKey: context.tenantContext?.tenantKey ?? null,
        objectType,
        property: targetField,
        sapField: field,
        optionCount: options.length,
      });
      return;
    }

    try {
      await this.hubspotPropertyGateway.updatePropertyOptions({
        accessToken,
        objectType,
        propertyName: targetField,
        options,
      });
    } catch (error) {
      context.metrics.hubspotFailed += 1;
      await this.recordWarning({
        ...context,
        objectType,
        code: DROPDOWN_WARNING_CODES.PROPERTY_UPDATE_FAILED,
        message: `Could not update the options of ${objectType}.${targetField}: ${error.message}`,
        details: { field, objectType, targetField, optionCount: options.length },
      });
      return;
    }

    context.metrics.hubspotSent += 1;
    context.metrics.hubspotUpdated += 1;
    context.metrics.dropdown.propertiesUpdated += 1;

    this.logger.info?.({
      msg: 'Dropdown property options updated',
      tenantKey: context.tenantContext?.tenantKey ?? null,
      objectType,
      property: targetField,
      sapField: field,
      optionCount: options.length,
      ...summary,
    });
  }

  async recordWarning({
    tenantContext,
    clientConfigId,
    syncLogId,
    metrics,
    objectType = null,
    code,
    message,
    details = null,
  }) {
    metrics.dropdown.warnings += 1;
    this.logger.warn?.({
      msg: 'Dropdown option sync warning',
      tenantKey: tenantContext?.tenantKey ?? null,
      code,
      warning: message,
      details,
    });

    if (typeof this.syncWarningRepository?.record !== 'function') {
      return;
    }

    await this.syncWarningRepository.record({
      tenantModels: tenantContext?.tenantModels,
      clientConfigId,
      syncLogId,
      objectType,
      code,
      message,
      details,
    });
  }

  async finish({
    tenantContext,
    clientConfigId,
    syncLogId,
    metrics,
    status,
    errorMessage = null,
    warning = null,
  }) {
    if (warning) {
      await this.recordWarning({
        tenantContext,
        clientConfigId,
        syncLogId,
        metrics,
        code: warning.code,
        message: warning.message,
        details: warning.details ?? null,
      });
    }

    await this.syncLogRepository.finish({ id: syncLogId, _id: syncLogId }, {
      status,
      recordsProcessed: metrics.recordsProcessed,
      sent: metrics.hubspotSent,
      failed: metrics.hubspotFailed,
      ...(errorMessage ? { errorMessage } : {}),
      finishedAt: this.dateProvider(),
    });

    if (clientConfigId) {
      if (status === 'completed') {
        await this.clientConfigRepository.markSyncSucceeded({
          tenantContext,
          configId: clientConfigId,
          lastRun: this.dateProvider(),
        });
      } else {
        await this.clientConfigRepository.markSyncFailed({
          tenantContext,
          configId: clientConfigId,
          errorMessage: errorMessage ?? 'Dropdown option sync failed',
        });
      }
    }

    return {
      ok: status === 'completed',
      status,
      ...(errorMessage ? { error: errorMessage } : {}),
      metrics,
    };
  }
}

export default SyncDropdownOptionsToHubspot;
