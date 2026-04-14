import { createRequire } from 'module';
import { jest } from '@jest/globals';

const require = createRequire(import.meta.url);
const { version } = require('../../package.json');
const mockConnect = jest.fn();
const mockMongoose = {
  connection: {
    readyState: 1,
  },
};

jest.unstable_mockModule('../../src/config/database.js', () => ({
  connect: mockConnect,
}));

jest.unstable_mockModule('mongoose', () => ({
  default: mockMongoose,
}));

const { health } = await import('../../src/controllers/health.controller.js');

describe('health.controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMongoose.connection.readyState = 1;
    mockConnect.mockResolvedValue();
  });

  it('returns app version from package metadata', async () => {
    const reply = {
      send: jest.fn((payload) => payload),
    };

    await health({}, reply);

    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        database: 'connected',
        version,
      })
    );
  });
});
