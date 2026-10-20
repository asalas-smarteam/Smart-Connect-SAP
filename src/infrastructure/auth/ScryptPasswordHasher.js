import crypto from 'crypto';
import { promisify } from 'util';
import ConcurrencyLimiter from './ConcurrencyLimiter.js';

const scrypt = promisify(crypto.scrypt);

const ALGORITHM = 'scrypt';
const COST = 16384;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;
// 128 * N * r = 16 MiB; el límite por defecto de Node es 32 MiB.
const MAX_MEMORY = 64 * 1024 * 1024;

// Con este hash se compara cuando el usuario no existe o está inactivo, para que el tiempo de
// respuesta del login no revele qué correos existen.
const DUMMY_PASSWORD = 'panel-dummy-password-never-matches';

function toPasswordString(value) {
  return typeof value === 'string' ? value : '';
}

function parseHash(stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== ALGORITHM) {
    return null;
  }

  const [, cost, blockSize, parallelization, salt, key] = parts.map((part, index) =>
    index >= 1 && index <= 3 ? Number(part) : part
  );

  if (cost !== COST || blockSize !== BLOCK_SIZE || parallelization !== PARALLELIZATION) {
    return null;
  }

  const saltBuffer = Buffer.from(salt, 'base64');
  const keyBuffer = Buffer.from(key, 'base64');
  if (saltBuffer.length !== SALT_BYTES || keyBuffer.length !== KEY_BYTES) {
    return null;
  }

  return { salt: saltBuffer, key: keyBuffer };
}

async function derive(password, salt) {
  return scrypt(toPasswordString(password), salt, KEY_BYTES, {
    N: COST,
    r: BLOCK_SIZE,
    p: PARALLELIZATION,
    maxmem: MAX_MEMORY,
  });
}

// Todo scrypt pasa por el limitador: como mucho 2 a la vez y 32 en cola. El pool de hilos de
// Node tiene 4 por defecto y lo comparten DNS y archivos; así quedan libres para el resto de la
// API aunque alguien mande una ráfaga de logins. Con la cola llena, PanelHasherBusyError.
export class ScryptPasswordHasher {
  #dummyHash = null;

  // El hash ficticio se calcula al construir (al registrar el plugin), no en el primer login:
  // así el primer "usuario no existe" no tarda el doble.
  constructor({ limiter = new ConcurrencyLimiter() } = {}) {
    this.limiter = limiter;
    this.#prepareDummyHash();
  }

  #derive(password, salt) {
    return this.limiter.run(() => derive(password, salt));
  }

  #prepareDummyHash() {
    this.#dummyHash = this.hash(DUMMY_PASSWORD);
    this.#dummyHash.catch(() => {
      this.#dummyHash = null;
    });
    return this.#dummyHash;
  }

  async hash(password) {
    const salt = crypto.randomBytes(SALT_BYTES);
    const key = await this.#derive(password, salt);
    return [
      ALGORITHM,
      COST,
      BLOCK_SIZE,
      PARALLELIZATION,
      salt.toString('base64'),
      key.toString('base64'),
    ].join('$');
  }

  async verify(password, storedHash) {
    const parsed = parseHash(storedHash);
    if (!parsed) {
      return false;
    }

    const candidate = await this.#derive(password, parsed.salt);
    return crypto.timingSafeEqual(candidate, parsed.key);
  }

  // Hace el mismo trabajo que verify y siempre devuelve false.
  async verifyDummy(password) {
    const dummyHash = await (this.#dummyHash ?? this.#prepareDummyHash());
    await this.verify(password, dummyHash);
    return false;
  }
}

export default ScryptPasswordHasher;
