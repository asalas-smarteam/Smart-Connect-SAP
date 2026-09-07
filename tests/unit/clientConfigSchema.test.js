import mongoose from 'mongoose';
import { clientConfigSchema } from '../../src/infrastructure/database/models/tenant/ClientConfig.js';

const ClientConfigTestModel = mongoose.model('ClientConfigSchemaTest', clientConfigSchema.clone());

function build(overrides) {
  return new ClientConfigTestModel({ mode: 'FULL', ...overrides });
}

describe('clientConfigSchema.executionTime', () => {
  it('accepts an array of times', () => {
    const doc = build({ executionTime: ['07:00', '12:00', '15:00'] });

    expect(doc.validateSync()).toBeUndefined();
    expect(doc.executionTime).toEqual(['07:00', '12:00', '15:00']);
  });

  it('wraps a bare string, the shape stored before this change', () => {
    const doc = build({ executionTime: '07:00' });

    expect(doc.validateSync()).toBeUndefined();
    expect(doc.executionTime).toEqual(['07:00']);
  });

  it('hydrates a document stored with a bare string without casting errors', () => {
    const doc = ClientConfigTestModel.hydrate({ mode: 'FULL', executionTime: '01:00' });

    expect(doc.executionTime).toEqual(['01:00']);
  });

  it('defaults to an empty array', () => {
    expect(build({}).executionTime).toEqual([]);
  });

  it('rejects a badly formatted time with a message naming the field', () => {
    const error = build({ executionTime: ['7:00'] }).validateSync();

    expect(error.errors.executionTime.message).toMatch(/executionTime/);
  });

  it('rejects more times than the cap', () => {
    const tooMany = Array.from(
      { length: 25 },
      (unused, index) => `${String(index % 24).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}`
    );
    const error = build({ executionTime: tooMany }).validateSync();

    expect(error.errors.executionTime.message).toMatch(/executionTime/);
  });
});
