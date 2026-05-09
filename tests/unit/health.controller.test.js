import { createRequire } from 'module';
import { jest } from '@jest/globals';
import GetHealthStatus from '../../src/application/use-cases/GetHealthStatus.js';
import { createHealthController } from '../../src/interfaces/http/controllers/health.controller.js';

const require = createRequire(import.meta.url);
const { version } = require('../../package.json');

describe('health.controller', () => {
  it('returns app version from package metadata', async () => {
    const getHealthStatus = new GetHealthStatus({
      databaseStatusProvider: {
        getStatus: jest.fn().mockResolvedValue({
          ok: true,
          database: 'connected',
        }),
      },
      version,
      dateProvider: () => new Date('2026-05-05T00:00:00.000Z'),
    });
    const health = createHealthController({ getHealthStatus });
    const reply = {
      send: jest.fn((payload) => payload),
    };

    await health({}, reply);

    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        database: 'connected',
        version,
        timestamp: '2026-05-05T00:00:00.000Z',
      })
    );
  });
});
