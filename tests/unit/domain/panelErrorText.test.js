import { CAUSE_GROUPS, classifyError } from '../../../src/domain/panel/errorCauses.js';
import { clientErrorText, sanitizeErrorText } from '../../../src/domain/panel/errorText.js';
import { clientSyncErrorItem, clientSyncErrorMessage, toEventView, toSyncView } from '../../../src/domain/panel/operationViews.js';

describe('error causes catalog (F5)', () => {
  it.each([
    ['La identificación fiscal del cliente está incompleta', 'fiscal_id_incomplete', 'fiscal_data'],
    ['El cliente C001 está inactivo', 'customer_inactive', 'master_blocked'],
    ['El negocio no tiene líneas de producto', 'no_line_items', 'deal_data'],
    ['El artículo ITEM-0042 no existe en destino', 'item_not_found', 'destination_validation'],
    ['connect ETIMEDOUT 18.213.238.80:443', 'timeout', 'connectivity'],
    ['getaddrinfo ENOTFOUND erp.cliente.com', 'connection_failed', 'connectivity'],
    ['socket hang up', 'connection_failed', 'connectivity'],
    ['algo raro pasó', 'other', 'other'],
  ])('classifies %j', (message, key, group) => {
    expect(classifyError(message)).toEqual(expect.objectContaining({ key, group }));
  });

  it('falls back to other for empty input and keeps the fixed groups', () => {
    expect(classifyError(null)).toEqual({ key: 'other', label: 'Otro error', group: 'other' });
    expect(CAUSE_GROUPS).toEqual(['deal_data', 'fiscal_data', 'destination_validation', 'master_blocked', 'connectivity', 'other']);
  });

  it('never uses system names in the labels', () => {
    for (const message of ['identificación fiscal', 'cliente inactivo', 'ETIMEDOUT', 'socket hang up', 'x']) {
      expect(classifyError(message).label).not.toMatch(/sap|hubspot/i);
    }
  });
});

describe('client error text (A3)', () => {
  it.each([
    ['Falló la llamada a https://api.cliente.com/v1/Orders?x=1', 'Falló la llamada a [enlace]'],
    ['No responde 10.0.0.12:50000 ni 192.168.1.5', 'No responde [servidor] ni [servidor]'],
    ['Host erp.printer.local:50000 caído', 'Host [servidor] caído'],
    ['Escribir a soporte@printer.com', 'Escribir a [correo]'],
    ['AxiosError: Request failed with status code 500', 'Request failed with status code 500'],
    ['Error de SAP Service Layer al crear en HubSpot', 'Error de el ERP al crear en el CRM'],
    ['Falla en fe80::1ff:fe23:4567:890a', 'Falla en [servidor]'],
  ])('sanitizes %j', (input, expected) => {
    expect(sanitizeErrorText(input)).toBe(expected);
  });

  it('keeps business text and times untouched', () => {
    expect(sanitizeErrorText('El artículo ITEM-0042 no existe. Hora 10:30:00')).toBe('El artículo ITEM-0042 no existe. Hora 10:30:00');
  });

  it('shows the label for connectivity errors', () => {
    expect(clientErrorText('connect ETIMEDOUT 18.213.238.80:443')).toBe('Tiempo de espera agotado.');
    expect(clientErrorText(null)).toBeNull();
  });
});

describe('client and staff views', () => {
  const event = { _id: 'e', status: 'errored', lastError: 'connect ECONNREFUSED 18.213.238.80:443', createdAt: new Date() };
  const webhookRun = {
    _id: 's',
    status: 'errored',
    errorMessage: [{ payload_Hubspot: { deal: 1 }, payload_SAP: { CardCode: 'C1' }, response_hubspot: null, response_SAP: { message: 'x' } }],
  };

  it('gives the client a readable lastError and Smarteam the raw one, both with cause', () => {
    const client = toEventView(event);
    const staff = toEventView(event, { side: 'smarteam' });

    expect(client.lastError).toBe('No se pudo conectar con el sistema destino.');
    expect(staff.lastError).toBe('connect ECONNREFUSED 18.213.238.80:443');
    expect(client.cause).toEqual(staff.cause);
    expect(client.cause.group).toBe('connectivity');
  });

  it('never gives the client the payloads stored in a run error', () => {
    const client = toSyncView(webhookRun);
    const staff = toSyncView(webhookRun, null, { side: 'smarteam' });

    expect(client.errorMessage).toEqual({ summary: '1 error en la corrida: x' });
    expect(JSON.stringify(client)).not.toMatch(/payload_|response_|CardCode/);
    expect(staff.errorMessage).toEqual(webhookRun.errorMessage);
    expect(client.task).toEqual({ id: 'event_queue', name: 'Cola de eventos', type: 'event_queue' });
  });

  it('reduces run errors to record and message for the client', () => {
    expect(clientSyncErrorItem({ record: 'ITEM-1', message: 'Sin precio', payload_SAP: { a: 1 } })).toEqual({ record: 'ITEM-1', message: 'Sin precio' });
    expect(clientSyncErrorItem({ itemCode: 7, error: { message: 'timeout en 10.0.0.1' } })).toEqual({ record: '7', message: 'Tiempo de espera agotado.' });
    expect(clientSyncErrorItem('texto suelto')).toEqual({ record: null, message: 'texto suelto' });
    expect(clientSyncErrorItem(null)).toEqual({ record: null, message: null });
    expect(clientSyncErrorMessage('Error: falló en https://x.com/a')).toBe('falló en [enlace]');
    expect(clientSyncErrorMessage({ a: 1 })).toEqual({ summary: '1 error(es) en la corrida' });
    expect(clientSyncErrorMessage(null)).toBeNull();
  });
});

describe('sanitizer hardening (security review)', () => {
  it('masks bracketed IPv6, zones, underscores in hosts, single-label hosts, paths and company databases', () => {
    expect(sanitizeErrorText('Falla en [2001:db8::1]:443 y fe80::1%eth0, host sap_server.corp.local, sapb1:50000, /app/src/x.js, SBO_PRINTER'))
      .toBe('Falla en [servidor] y [servidor], host [servidor], [servidor], [ruta], [base]');
  });

  it('stays fast on huge inputs', () => {
    const started = Date.now();
    for (const input of ['a.'.repeat(50000), 'x@'.repeat(50000), 'cliente '.repeat(15000)]) {
      clientErrorText(input);
      classifyError(input);
    }
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('never prints an object as a record', () => {
    expect(clientSyncErrorItem({ record: { a: 1 }, message: 'x' })).toEqual({ record: null, message: 'x' });
  });
});
