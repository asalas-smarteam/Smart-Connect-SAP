import {
  CLIENT_CONFIG_TASK_TYPES,
  resolveClientConfigTaskType,
} from '#domain/sync/dropdown-options.constants.js';

// Which use case runs a given ClientConfig. Both use cases share the
// execute({ config, tenantContext }) signature and the { ok, status, metrics }
// result, so routing is a lookup and nothing downstream needs to branch.
//
// Lives here rather than in the BullMQ job module so the HTTP manual-trigger
// path can route identically without importing the worker.
export function resolveSyncUseCase({ config, syncUseCase, dropdownUseCase }) {
  const taskType = resolveClientConfigTaskType(config?.taskType);

  if (taskType === CLIENT_CONFIG_TASK_TYPES.DROPDOWN_OPTIONS) {
    if (!dropdownUseCase) {
      throw new Error('A dropdown options use case is required to run a DROPDOWN_OPTIONS config');
    }

    return dropdownUseCase;
  }

  return syncUseCase;
}

export default resolveSyncUseCase;
