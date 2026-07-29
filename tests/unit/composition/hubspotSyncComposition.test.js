// Guards against a whole class of regressions the use-case unit tests cannot
// see: the composition root importing a module that is missing from the repo
// (or exporting the wrong shape), which only fails at boot on a clean checkout.
describe('hubspot-sync composition', () => {
  it('imports and builds the send-mapped-items use case', async () => {
    const module = await import('../../../src/composition/hubspot-sync.composition.js');

    expect(typeof module.buildSendMappedItemsToHubspot).toBe('function');

    const useCase = module.buildSendMappedItemsToHubspot();

    expect(useCase).toEqual(expect.any(Object));
    expect(typeof useCase.execute).toBe('function');
  });

  // The identity property is what the prefetch index matches on. A default in
  // the use case is not enough: a wrong wire here silently duplicates the whole
  // base, so the composition site has to state it and this test has to see it.
  it('wires the identity properties for main records and child contacts', async () => {
    const { buildSendMappedItemsToHubspot } = await import('../../../src/composition/hubspot-sync.composition.js');
    const useCase = buildSendMappedItemsToHubspot();

    expect(useCase.crmBatchProcessor.identityProperty).toBe('idsap');
    expect(useCase.crmBatchProcessor.syncCompanyContactsInBatches.identityProperty).toBe('internalcode');
  });
});
