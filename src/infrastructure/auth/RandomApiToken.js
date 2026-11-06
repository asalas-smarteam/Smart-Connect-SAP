import crypto from 'crypto';
import { API_TOKEN_DISPLAY_PREFIX_LENGTH, API_TOKEN_PREFIX } from '#domain/panel/apiTokens.js';

const TOKEN_BYTES = 32;

// Tokens personales del panel (contrato 12, M2): 'spn_' + 32 bytes aleatorios en base64url sin
// relleno (43 caracteres), 47 en total. Solo se guarda el SHA-256 en hex del token completo.
export class RandomApiToken {
  generate() {
    const token = `${API_TOKEN_PREFIX}${crypto.randomBytes(TOKEN_BYTES).toString('base64url')}`;
    return {
      token,
      hash: this.hash(token),
      prefix: token.slice(0, API_TOKEN_DISPLAY_PREFIX_LENGTH),
    };
  }

  hash(value) {
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
  }
}

export default RandomApiToken;
