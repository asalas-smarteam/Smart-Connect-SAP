import { ACCOUNT_TYPES } from '#domain/panel/accounts.js';
import { isActiveToken, isApiTokenFormat } from '#domain/panel/apiTokens.js';
import { permissionsFor } from '#domain/panel/permissions.js';
import { fail, panelReasons } from './panelReasons.js';

// De un token personal (Authorization: Bearer spn_…) a un usuario del panel (contrato 12, M3).
// Mismo usuario que ResolvePanelSession, cargado en cada request: una desactivación o un cambio
// de cuenta rigen en el request siguiente. Todos los rechazos son el mismo INVALID_TOKEN, sin
// decir por qué. El token en claro nunca se loguea ni se guarda.
export class ResolveApiToken {
  constructor({ apiTokenRepository, apiTokenCodec, userRepository, logger = null, now = () => new Date() }) {
    this.apiTokenRepository = apiTokenRepository;
    this.apiTokenCodec = apiTokenCodec;
    this.userRepository = userRepository;
    this.logger = logger;
    this.now = now;
  }

  async execute({ token } = {}) {
    // El formato se comprueba antes de hashear y de ir a la base.
    if (!isApiTokenFormat(token)) {
      return fail(panelReasons.INVALID_TOKEN);
    }

    const at = this.now();
    const record = await this.apiTokenRepository.findByHash(this.apiTokenCodec.hash(token));
    if (!record || !isActiveToken(record, at)) {
      return fail(panelReasons.INVALID_TOKEN);
    }

    const user = await this.userRepository.findById(record.userId);
    if (!user || user.active === false || user.accountType !== ACCOUNT_TYPES.SMARTEAM) {
      return fail(panelReasons.INVALID_TOKEN);
    }

    this.#touch(record.id, at);

    return {
      ok: true,
      data: {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          accountType: user.accountType,
          role: user.role ?? null,
          tenantKey: user.tenantKey ?? null,
          permissions: permissionsFor({ accountType: user.accountType, role: user.role }),
        },
        mustChangePassword: Boolean(user.mustChangePassword),
        tokenId: String(record.id),
        prefix: record.prefix,
      },
    };
  }

  // lastUsedAt sin frenar la respuesta (M7): el repositorio escribe como mucho una vez por
  // minuto. Si falla, se loguea (sin el token) y el request sigue.
  #touch(id, at) {
    (async () => {
      await this.apiTokenRepository.touchLastUsed(id, at);
    })().catch((error) => {
      this.logger?.warn?.({ msg: 'Panel API token: lastUsedAt not updated', tokenId: String(id), error: error?.message });
    });
  }
}

export default ResolveApiToken;
