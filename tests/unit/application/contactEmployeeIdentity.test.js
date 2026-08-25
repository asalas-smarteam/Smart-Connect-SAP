import {
  plusAddressEmail,
  resolveContactEmployeeEmail,
  claimEmail,
} from '../../../src/application/services/contactEmployeeIdentity.service.js';

describe('plusAddressEmail', () => {
  it('inserta el internalCode como plus addressing', () => {
    expect(plusAddressEmail('recepcion@tecnopack.net', 91643)).toBe('recepcion+91643@tecnopack.net');
    expect(plusAddressEmail('  RECEPCION@Tecnopack.NET  ', 'IC-2')).toBe('recepcion+IC-2@tecnopack.net');
  });

  it('devuelve null cuando el email base o el código no sirven', () => {
    expect(plusAddressEmail('sin-arroba', 91643)).toBeNull();
    expect(plusAddressEmail('@dominio.com', 91643)).toBeNull();
    expect(plusAddressEmail('local@', 91643)).toBeNull();
    expect(plusAddressEmail('', 91643)).toBeNull();
    expect(plusAddressEmail('a@b.com', null)).toBeNull();
    expect(plusAddressEmail('a@b.com', '  ')).toBeNull();
  });
});

describe('resolveContactEmployeeEmail', () => {
  it('sin dueño ni reclamo devuelve el email original intacto', () => {
    expect(resolveContactEmployeeEmail({
      email: 'Recepcion@Tecnopack.net',
      internalCode: 91643,
      owner: null,
      claimedEmails: new Map(),
    })).toBe('Recepcion@Tecnopack.net');
  });

  it('dueño con el MISMO internalcode conserva el email limpio (es él mismo)', () => {
    expect(resolveContactEmployeeEmail({
      email: 'recepcion@tecnopack.net',
      internalCode: 91643,
      owner: { internalcode: '91643' },
      claimedEmails: new Map(),
    })).toBe('recepcion@tecnopack.net');
  });

  it('dueño con OTRO internalcode fuerza el plus addressing', () => {
    expect(resolveContactEmployeeEmail({
      email: 'recepcion@tecnopack.net',
      internalCode: 91794,
      owner: { internalcode: '91643' },
      claimedEmails: new Map(),
    })).toBe('recepcion+91794@tecnopack.net');
  });

  it('dueño SIN internalcode (contacto manual o BP con solo idsap) también fuerza el plus', () => {
    expect(resolveContactEmployeeEmail({
      email: 'recepcion@tecnopack.net',
      internalCode: 91794,
      owner: { internalcode: undefined },
      claimedEmails: new Map(),
    })).toBe('recepcion+91794@tecnopack.net');
  });

  it('un email ya reclamado en la corrida por otro código fuerza el plus sin consultar owner', () => {
    const claimedEmails = new Map();
    claimEmail(claimedEmails, 'recepcion@tecnopack.net', 91643);
    expect(resolveContactEmployeeEmail({
      email: 'recepcion@tecnopack.net',
      internalCode: 91794,
      owner: null,
      claimedEmails,
    })).toBe('recepcion+91794@tecnopack.net');
  });

  it('un email reclamado por el MISMO código sigue limpio (mismo CE en dos empresas)', () => {
    const claimedEmails = new Map();
    claimEmail(claimedEmails, 'shared@x.com', 9);
    expect(resolveContactEmployeeEmail({
      email: 'shared@x.com',
      internalCode: 9,
      owner: null,
      claimedEmails,
    })).toBe('shared@x.com');
  });

  it('si el plus no se puede construir, conserva el email original (colapso viejo)', () => {
    const claimedEmails = new Map();
    claimEmail(claimedEmails, 'x@y.com', 1);
    // internalCode vacío: no hay con qué distinguirlo, mejor el comportamiento viejo
    expect(resolveContactEmployeeEmail({
      email: 'x@y.com',
      internalCode: '',
      owner: null,
      claimedEmails,
    })).toBe('x@y.com');
  });

  it('email vacío vuelve intacto', () => {
    expect(resolveContactEmployeeEmail({
      email: '',
      internalCode: 91643,
      owner: null,
      claimedEmails: new Map(),
    })).toBe('');
  });
});

describe('claimEmail', () => {
  it('normaliza y respeta first-claim-wins', () => {
    const claimedEmails = new Map();
    claimEmail(claimedEmails, ' A@B.com ', 'IC-1');
    claimEmail(claimedEmails, 'a@b.com', 'IC-2');
    expect(claimedEmails.get('a@b.com')).toBe('ic-1');
  });

  it('ignora emails vacíos', () => {
    const claimedEmails = new Map();
    claimEmail(claimedEmails, '', 1);
    claimEmail(claimedEmails, null, 1);
    expect(claimedEmails.size).toBe(0);
  });
});
