import { jest } from '@jest/globals';
import BypassEmailConfigRepository, {
  BYPASS_EMAIL_CONFIG_KEY,
} from '../../../src/infrastructure/config/BypassEmailConfigRepository.js';

describe('BypassEmailConfigRepository', () => {
  it('reads bypassEmail without creating a default document', async () => {
    const lean = jest.fn().mockResolvedValue({
      key: BYPASS_EMAIL_CONFIG_KEY,
      value: true,
    });
    const findOne = jest.fn().mockReturnValue({ lean });
    const repository = new BypassEmailConfigRepository();

    const enabled = await repository.isBypassEmailEnabled({
      tenantModels: {
        Configuration: { findOne },
      },
    });

    expect(enabled).toBe(true);
    expect(findOne).toHaveBeenCalledWith({ key: BYPASS_EMAIL_CONFIG_KEY });
  });

  it('treats missing tenant configuration as disabled', async () => {
    const repository = new BypassEmailConfigRepository();

    const enabled = await repository.isBypassEmailEnabled({ tenantModels: {} });

    expect(enabled).toBe(false);
  });
});
