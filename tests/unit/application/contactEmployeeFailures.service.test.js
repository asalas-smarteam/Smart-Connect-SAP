import { jest } from '@jest/globals';
import {
  recordContactEmployeeFailures,
  buildContactEmployeeFailureMessage,
  buildContactEmployeeFailureNote,
} from '#application/services/contact-employee-failures.service.js';

function buildSapError(message) {
  const error = new Error('Request failed with status code 400');
  error.response = { data: { error: { message: { lang: 'en-us', value: message } } } };
  return error;
}

const TITLE_TOO_LONG = "CServiceData::SetPropertyValueString failed; Value too long in property 'Title' of 'ContactEmployee'";

describe('recordContactEmployeeFailures', () => {
  let auditTrail;
  let logger;

  beforeEach(() => {
    auditTrail = { payload_SAP: {}, response_SAP: {} };
    logger = { error: jest.fn(), warn: jest.fn() };
  });

  it('devuelve el email, el nombre y el mensaje resuelto de SAP por cada fallo', () => {
    const failures = recordContactEmployeeFailures({
      contactEmployeeResult: {
        errors: [
          {
            contact: { email: 'linda.colop@fundap.com.gt' },
            requestPayload: { Name: 'LINDA MARIBEL COLOP', E_Mail: 'linda.colop@fundap.com.gt' },
            error: buildSapError(TITLE_TOO_LONG),
          },
        ],
      },
      auditTrail,
      logger,
      cardCode: 'CLO006316',
      dealId: '57553455696',
    });

    expect(failures).toEqual([
      {
        email: 'linda.colop@fundap.com.gt',
        name: 'LINDA MARIBEL COLOP',
        message: TITLE_TOO_LONG,
      },
    ]);
  });

  it('loguea un error por cada ContactEmployee rechazado', () => {
    recordContactEmployeeFailures({
      contactEmployeeResult: {
        errors: [
          {
            contact: { email: 'uno@example.com' },
            requestPayload: { Name: 'Uno', E_Mail: 'uno@example.com' },
            error: buildSapError(TITLE_TOO_LONG),
          },
          {
            contact: { email: 'dos@example.com' },
            requestPayload: { Name: 'Dos', E_Mail: 'dos@example.com' },
            error: buildSapError('This entry already exists'),
          },
        ],
      },
      auditTrail,
      logger,
      cardCode: 'CLO006316',
      dealId: '57553455696',
    });

    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith({
      msg: 'ContactEmployee rechazado por SAP: el documento sigue adelante sin el',
      dealId: '57553455696',
      cardCode: 'CLO006316',
      email: 'uno@example.com',
      name: 'Uno',
      error: TITLE_TOO_LONG,
    });
  });

  it('deja los fallos en response_SAP.contactEmployeeErrors para que entren al sapAudit', () => {
    recordContactEmployeeFailures({
      contactEmployeeResult: {
        errors: [
          {
            contact: { email: 'uno@example.com' },
            requestPayload: { Name: 'Uno', E_Mail: 'uno@example.com' },
            error: buildSapError(TITLE_TOO_LONG),
          },
        ],
      },
      auditTrail,
      logger,
      cardCode: 'CLO006316',
      dealId: '57553455696',
    });

    expect(auditTrail.response_SAP.contactEmployeeErrors).toEqual([
      { email: 'uno@example.com', name: 'Uno', message: TITLE_TOO_LONG },
    ]);
  });

  it('no toca el auditTrail ni loguea cuando no hubo fallos', () => {
    const failures = recordContactEmployeeFailures({
      contactEmployeeResult: { errors: [] },
      auditTrail,
      logger,
      cardCode: 'CLO006316',
      dealId: '57553455696',
    });

    expect(failures).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
    expect(auditTrail.response_SAP).not.toHaveProperty('contactEmployeeErrors');
  });

  // Un adapter viejo (o el default de contactEmployeeResult antes de que corra
  // addContactEmployeesIfNeeded) no trae `errors`. No debe reventar.
  it('tolera un contactEmployeeResult sin errors', () => {
    expect(
      recordContactEmployeeFailures({ contactEmployeeResult: {}, auditTrail, logger })
    ).toEqual([]);
    expect(recordContactEmployeeFailures({ auditTrail, logger })).toEqual([]);
  });

  it('cae al email del contacto cuando el payload de SAP no llego a armarse', () => {
    const failures = recordContactEmployeeFailures({
      contactEmployeeResult: {
        errors: [
          {
            contact: { email: 'sin.payload@example.com', firstname: 'Sin Payload' },
            requestPayload: null,
            error: buildSapError(TITLE_TOO_LONG),
          },
        ],
      },
      auditTrail,
      logger,
    });

    expect(failures[0].email).toBe('sin.payload@example.com');
    expect(failures[0].name).toBe('Sin Payload');
  });
});

describe('buildContactEmployeeFailureMessage', () => {
  // Este texto termina en `lastError` del WebhookEvent y, de ahi, en la nota del deal:
  // es lo unico que va a leer quien tiene que corregir la data en HubSpot. Tiene que
  // decir que NO se sincronizo y que hay que reenviar.
  it('dice que no se sincronizo y lista cada contacto rechazado', () => {
    const message = buildContactEmployeeFailureMessage([
      { email: 'linda.colop@fundap.com.gt', name: 'LINDA MARIBEL COLOP', message: TITLE_TOO_LONG },
      { email: 'beverly@fundap.com.gt', name: 'BEVERLY', message: TITLE_TOO_LONG },
    ]);

    expect(message).toContain('No se sincronizó');
    expect(message).toContain('HubSpot');
    expect(message).toContain('2');
    expect(message).toContain('linda.colop@fundap.com.gt');
    expect(message).toContain('LINDA MARIBEL COLOP');
    expect(message).toContain('beverly@fundap.com.gt');
    expect(message).toContain(TITLE_TOO_LONG);
  });

  // `lastError` se trunca a 2000 caracteres aguas abajo (error-message.service.js), asi que
  // el mensaje no puede crecer sin limite: con muchos contactos se corta la lista y se dice
  // cuantos quedaron fuera, en vez de perder el final del texto en silencio.
  it('acota la lista y dice cuantos contactos quedaron sin detallar', () => {
    const failures = Array.from({ length: 12 }, (unused, index) => ({
      email: `contacto${index}@example.com`,
      name: `Contacto ${index}`,
      message: TITLE_TOO_LONG,
    }));

    const message = buildContactEmployeeFailureMessage(failures);

    expect(message).toContain('12');
    expect(message).toContain('contacto0@example.com');
    expect(message).not.toContain('contacto11@example.com');
    expect(message).toContain('y 7 más');
    expect(message.length).toBeLessThanOrEqual(2000);
  });

  // Un solo mensaje de SAP ya puede venir de 2000 caracteres (error-message.service.js lo
  // trunca ahi), asi que acotar la CANTIDAD de lineas no alcanza: hay que acotar el largo.
  it('nunca pasa de 2000 caracteres aunque un mensaje de SAP sea enorme', () => {
    const message = buildContactEmployeeFailureMessage([
      { email: 'uno@example.com', name: 'Uno', message: 'x'.repeat(1900) },
      { email: 'dos@example.com', name: 'Dos', message: 'y'.repeat(1900) },
    ]);

    expect(message.length).toBeLessThanOrEqual(2000);
  });

  it('devuelve null cuando no hay fallos', () => {
    expect(buildContactEmployeeFailureMessage([])).toBeNull();
    expect(buildContactEmployeeFailureMessage()).toBeNull();
  });
});

describe('buildContactEmployeeFailureNote', () => {
  // Solo se usa en la rama del BYPASS: ahi el documento SI se creo y el evento queda
  // completed, asi que el texto tiene que decir lo contrario que el de bloqueo.
  it('nombra el documento creado y lista cada contacto que no entro', () => {
    const note = buildContactEmployeeFailureNote({
      failures: [
        { email: 'linda.colop@fundap.com.gt', name: 'LINDA MARIBEL COLOP', message: TITLE_TOO_LONG },
        { email: 'beverly@fundap.com.gt', name: 'BEVERLY', message: TITLE_TOO_LONG },
      ],
      docNum: 1074112,
    });

    expect(note).toContain('1074112');
    expect(note).toContain('se creó');
    expect(note).toContain('linda.colop@fundap.com.gt');
    expect(note).toContain('beverly@fundap.com.gt');
    expect(note).toContain(TITLE_TOO_LONG);
    expect(note).not.toContain('No se sincronizó');
  });

  it('no menciona el numero de documento cuando no hay', () => {
    const note = buildContactEmployeeFailureNote({
      failures: [{ email: 'uno@example.com', name: 'Uno', message: 'boom' }],
      docNum: null,
    });

    expect(note).not.toContain('null');
    expect(note).toContain('uno@example.com');
  });

  it('devuelve null cuando no hay fallos', () => {
    expect(buildContactEmployeeFailureNote({ failures: [], docNum: 1 })).toBeNull();
    expect(buildContactEmployeeFailureNote({ docNum: 1 })).toBeNull();
  });
});
