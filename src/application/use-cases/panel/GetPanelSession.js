import { fail, panelReasons } from './panelReasons.js';
import { toSessionBody } from './panelUserView.js';

export class GetPanelSession {
  constructor({ userRepository, tenantDirectory }) {
    this.userRepository = userRepository;
    this.tenantDirectory = tenantDirectory;
  }

  async execute({ userId } = {}) {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      return fail(panelReasons.UNAUTHORIZED);
    }

    const tenant = user.tenantKey ? await this.tenantDirectory.findByKey(user.tenantKey) : null;
    return { ok: true, data: toSessionBody(user, tenant?.companyName) };
  }
}

export default GetPanelSession;
