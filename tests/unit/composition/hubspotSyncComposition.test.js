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
});
