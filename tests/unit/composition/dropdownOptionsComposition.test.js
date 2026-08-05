import { buildSyncDropdownOptionsToHubspot } from '../../../src/composition/dropdown-options.composition.js';
import SyncDropdownOptionsToHubspot from '../../../src/application/use-cases/SyncDropdownOptionsToHubspot.js';

describe('dropdown options composition', () => {
  // assertPort throws while wiring if an adapter is missing a port method, so
  // building the use case is the check that every contract is satisfied.
  it('wires every adapter against its port', () => {
    const useCase = buildSyncDropdownOptionsToHubspot();

    expect(useCase).toBeInstanceOf(SyncDropdownOptionsToHubspot);
  });

  it('exposes the collaborators the use case drives', () => {
    const useCase = buildSyncDropdownOptionsToHubspot();

    expect(typeof useCase.dropdownConfigRepository.getDropdownOptionsConfig).toBe('function');
    expect(typeof useCase.dropdownCatalog.fetchRows).toBe('function');
    expect(typeof useCase.dropdownTargetRepository.findTargetsBySourceFields).toBe('function');
    expect(typeof useCase.hubspotPropertyGateway.findProperty).toBe('function');
    expect(typeof useCase.hubspotPropertyGateway.updatePropertyOptions).toBe('function');
    expect(typeof useCase.sapFlavorRepository.resolveSapFlavor).toBe('function');
    expect(typeof useCase.syncWarningRepository.record).toBe('function');
  });
});
