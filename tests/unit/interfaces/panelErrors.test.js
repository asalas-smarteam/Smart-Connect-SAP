import { jest } from '@jest/globals';
import { fail, panelReasons } from '../../../src/application/use-cases/panel/panelReasons.js';
import {
  INVALID_TOKEN_MESSAGE,
  sendFailure,
  sendInvalidToken,
} from '../../../src/interfaces/http/panel/panelErrors.js';

function fakeReply() {
  const reply = {
    statusCode: null,
    headers: {},
    body: undefined,
    code: jest.fn((status) => {
      reply.statusCode = status;
      return reply;
    }),
    header: jest.fn((name, value) => {
      reply.headers[name] = value;
      return reply;
    }),
    send: jest.fn((payload) => {
      reply.body = payload;
      return reply;
    }),
  };
  return reply;
}

describe('fail', () => {
  it('keeps the shape of the existing calls', () => {
    expect(fail(panelReasons.NOT_FOUND)).toEqual({ ok: false, reason: 'NOT_FOUND' });
    expect(fail(panelReasons.VALIDATION_ERROR, 'x')).toEqual({ ok: false, reason: 'VALIDATION_ERROR', message: 'x' });
  });

  it('adds retryAfterSeconds only when it comes', () => {
    expect(fail(panelReasons.TOO_MANY_ATTEMPTS, 'Espera.', { retryAfterSeconds: 60 })).toEqual({
      ok: false,
      reason: 'TOO_MANY_ATTEMPTS',
      message: 'Espera.',
      retryAfterSeconds: 60,
    });
    expect(fail(panelReasons.TOO_MANY_ATTEMPTS, 'Espera.', {})).not.toHaveProperty('retryAfterSeconds');
  });
});

describe('sendFailure', () => {
  it('sets Retry-After when the result carries retryAfterSeconds', () => {
    const reply = fakeReply();
    sendFailure(reply, fail(panelReasons.TOO_MANY_ATTEMPTS, 'Espera.', { retryAfterSeconds: 900 }));
    expect(reply.statusCode).toBe(429);
    expect(reply.headers['Retry-After']).toBe('900');
    expect(reply.body).toEqual({ error: 'too_many_attempts', message: 'Espera.' });
  });

  it('does not set headers for a plain failure', () => {
    const reply = fakeReply();
    sendFailure(reply, fail(panelReasons.TOO_MANY_ATTEMPTS, 'Espera.'));
    expect(reply.header).not.toHaveBeenCalled();
  });

  it('answers INVALID_TOKEN with 401, WWW-Authenticate and the default message', () => {
    const reply = fakeReply();
    sendFailure(reply, fail(panelReasons.INVALID_TOKEN));
    expect(reply.statusCode).toBe(401);
    expect(reply.headers['WWW-Authenticate']).toBe('Bearer error="invalid_token"');
    expect(reply.body).toEqual({ error: 'invalid_token', message: INVALID_TOKEN_MESSAGE });
    expect(INVALID_TOKEN_MESSAGE).toBe('El token no es válido o venció. Crea uno nuevo en Mi cuenta.');
  });

  it('sendInvalidToken does the same', () => {
    const reply = fakeReply();
    sendInvalidToken(reply);
    expect(reply.statusCode).toBe(401);
    expect(reply.headers['WWW-Authenticate']).toBe('Bearer error="invalid_token"');
    expect(reply.body).toEqual({ error: 'invalid_token', message: INVALID_TOKEN_MESSAGE });
  });

  it.each([
    [panelReasons.TOKEN_LIMIT, 409, 'token_limit'],
    [panelReasons.AMBIGUOUS_CODE, 409, 'ambiguous_code'],
    [panelReasons.REQUEST_IN_PROGRESS, 409, 'request_in_progress'],
    [panelReasons.IDEMPOTENCY_KEY_REUSED, 422, 'idempotency_key_reused'],
  ])('maps %s to %i %s', (reason, status, error) => {
    const reply = fakeReply();
    sendFailure(reply, fail(reason));
    expect(reply.statusCode).toBe(status);
    expect(reply.body).toEqual({ error });
  });
});
