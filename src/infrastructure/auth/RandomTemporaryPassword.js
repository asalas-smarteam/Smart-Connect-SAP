import crypto from 'crypto';

// Sin caracteres ambiguos (0/O, 1/l/I) para que se pueda dictar o copiar a mano.
export const TEMPORARY_PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
export const TEMPORARY_PASSWORD_LENGTH = 14;

export class RandomTemporaryPassword {
  generate() {
    let password = '';
    for (let index = 0; index < TEMPORARY_PASSWORD_LENGTH; index += 1) {
      password += TEMPORARY_PASSWORD_ALPHABET[crypto.randomInt(TEMPORARY_PASSWORD_ALPHABET.length)];
    }
    return password;
  }
}

export default RandomTemporaryPassword;
