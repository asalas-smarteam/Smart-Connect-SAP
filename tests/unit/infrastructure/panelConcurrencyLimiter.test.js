import { jest } from '@jest/globals';
import ConcurrencyLimiter from '../../../src/infrastructure/auth/ConcurrencyLimiter.js';
import ScryptPasswordHasher from '../../../src/infrastructure/auth/ScryptPasswordHasher.js';
import { PanelHasherBusyError } from '../../../src/domain/panel/errors.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('ConcurrencyLimiter', () => {
  it('never runs more than maxConcurrent tasks and serves the queue in order', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 2, maxQueue: 10 });
    const gates = Array.from({ length: 5 }, deferred);
    const started = [];
    let running = 0;
    let peak = 0;

    const runs = gates.map((gate, index) => limiter.run(async () => {
      started.push(index);
      running += 1;
      peak = Math.max(peak, running);
      await gate.promise;
      running -= 1;
      return index;
    }));

    await flush();
    expect(started).toEqual([0, 1]);

    gates[1].resolve();
    await flush();
    expect(started).toEqual([0, 1, 2]);

    gates.forEach((gate) => gate.resolve());
    await expect(Promise.all(runs)).resolves.toEqual([0, 1, 2, 3, 4]);
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  it('rejects with PanelHasherBusyError without running the task when the queue is full', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 1 });
    const gate = deferred();
    const first = limiter.run(() => gate.promise);
    const second = limiter.run(async () => 'second');
    const third = jest.fn(async () => 'third');

    await expect(limiter.run(third)).rejects.toBeInstanceOf(PanelHasherBusyError);
    expect(third).not.toHaveBeenCalled();

    gate.resolve('first');
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
  });

  it('frees the slot when a task fails', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 0 });

    await expect(limiter.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(limiter.run(async () => 'ok')).resolves.toBe('ok');
    expect(limiter.active).toBe(0);
  });
});

describe('ScryptPasswordHasher with a saturated limiter', () => {
  it('throws PanelHasherBusyError instead of computing', async () => {
    const busyLimiter = { run: jest.fn(async () => { throw new PanelHasherBusyError(); }) };
    const hasher = new ScryptPasswordHasher({ limiter: busyLimiter });

    await expect(hasher.hash('una-clave-larga')).rejects.toMatchObject({ code: 'PANEL_HASHER_BUSY' });
    await expect(hasher.verify('x', `scrypt$16384$8$1$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(64).toString('base64')}`))
      .rejects.toMatchObject({ code: 'PANEL_HASHER_BUSY' });
  });

  it('runs every derivation through the limiter', async () => {
    const limiter = new ConcurrencyLimiter();
    const spy = jest.spyOn(limiter, 'run');
    const hasher = new ScryptPasswordHasher({ limiter });

    const stored = await hasher.hash('una-clave-larga');
    await hasher.verify('una-clave-larga', stored);
    await hasher.verifyDummy('x');

    // dummy del constructor + hash + verify + verifyDummy
    expect(spy).toHaveBeenCalledTimes(4);
  });
});
