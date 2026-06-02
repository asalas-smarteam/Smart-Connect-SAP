import {
  assertPort,
  assertPorts,
  createPort,
} from '../../../src/application/ports/port-validator.js';

describe('port-validator', () => {
  it('returns the adapter when it implements every required method', () => {
    const port = createPort({
      name: 'ExamplePort',
      methods: ['findById', 'save'],
    });
    const adapter = {
      findById() {},
      save() {},
    };

    expect(assertPort(adapter, port)).toBe(adapter);
  });

  it('fails with a clear message when methods are missing', () => {
    const port = createPort({
      name: 'ExamplePort',
      methods: ['findById', 'save', 'deleteById'],
    });
    const adapter = {
      findById() {},
    };

    expect(() => assertPort(adapter, port)).toThrow(
      'ExamplePort missing methods: save, deleteById'
    );
  });

  it('fails when the adapter is nullish', () => {
    const port = createPort({
      name: 'ExamplePort',
      methods: ['findById'],
    });

    expect(() => assertPort(null, port)).toThrow('ExamplePort missing methods: findById');
    expect(() => assertPort(undefined, port)).toThrow('ExamplePort missing methods: findById');
  });

  it('rejects ports without a name or methods', () => {
    expect(() => createPort({ name: '', methods: ['findById'] })).toThrow(
      'Port name is required'
    );
    expect(() => createPort({ name: 'EmptyPort', methods: [] })).toThrow(
      'EmptyPort must define at least one method'
    );
    expect(() => assertPort({}, { name: 'EmptyPort', methods: [] })).toThrow(
      'EmptyPort must define at least one method'
    );
  });

  it('validates multiple port definitions', () => {
    const firstAdapter = { send() {} };
    const secondAdapter = { start() {}, finish() {} };
    const adapters = assertPorts([
      {
        adapter: firstAdapter,
        port: createPort({ name: 'SenderPort', methods: ['send'] }),
      },
      {
        adapter: secondAdapter,
        port: createPort({ name: 'SyncLogPort', methods: ['start', 'finish'] }),
      },
    ]);

    expect(adapters).toEqual([firstAdapter, secondAdapter]);
  });

  it('normalizes duplicate and blank method names', () => {
    const port = createPort({
      name: 'ExamplePort',
      methods: ['findById', 'findById', '', null, ' save '],
    });

    expect(port.methods).toEqual(['findById', 'save']);
  });
});
