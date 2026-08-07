import { resolveErrorMessageText } from '../../../src/application/services/error-message.service.js';

describe('resolveErrorMessageText', () => {
  it('extracts the SAP B1 Service Layer nested { lang, value } message', () => {
    const error = {
      response: {
        data: {
          error: {
            message: {
              lang: 'en-us',
              value: 'To generate this document, first define the numbering series',
            },
          },
        },
      },
    };

    expect(resolveErrorMessageText(error)).toBe(
      'To generate this document, first define the numbering series'
    );
  });

  it('returns error.response.data.error.message as-is when it is already a string', () => {
    const error = {
      response: {
        data: {
          error: {
            message: 'Already a plain string',
          },
        },
      },
    };

    expect(resolveErrorMessageText(error)).toBe('Already a plain string');
  });

  it('falls back to error.response.data.message when it is a string', () => {
    const error = {
      response: {
        data: {
          message: 'Top-level data message',
        },
      },
    };

    expect(resolveErrorMessageText(error)).toBe('Top-level data message');
  });

  it('falls back to error.response.data.message.value when data.message is an object', () => {
    const error = {
      response: {
        data: {
          message: { value: 'Nested data message value' },
        },
      },
    };

    expect(resolveErrorMessageText(error)).toBe('Nested data message value');
  });

  it('falls back to error.message when nothing else is present', () => {
    const error = new Error('Plain error message');

    expect(resolveErrorMessageText(error)).toBe('Plain error message');
  });

  it('falls back to JSON.stringify for an unrecognized shape', () => {
    const error = { some: 'unrecognized', shape: 42 };

    expect(resolveErrorMessageText(error)).toBe(JSON.stringify(error));
  });

  it('never throws on a circular object and returns a string', () => {
    const error = { message: undefined };
    error.self = error;

    expect(() => resolveErrorMessageText(error)).not.toThrow();
    expect(typeof resolveErrorMessageText(error)).toBe('string');
  });

  it('returns "Unknown error" for null', () => {
    expect(resolveErrorMessageText(null)).toBe('Unknown error');
  });

  it('returns "Unknown error" for undefined', () => {
    expect(resolveErrorMessageText(undefined)).toBe('Unknown error');
  });

  it('truncates the resolved message to 2000 characters', () => {
    const error = new Error('x'.repeat(3000));

    const result = resolveErrorMessageText(error);

    expect(result).toHaveLength(2000);
    expect(result).toBe('x'.repeat(2000));
  });
});
