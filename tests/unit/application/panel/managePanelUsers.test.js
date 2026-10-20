import ManagePanelUsers from '../../../../src/application/use-cases/panel/ManagePanelUsers.js';
import { panelReasons } from '../../../../src/application/use-cases/panel/panelReasons.js';
import {
  FakePasswordHasher,
  FakeTenantDirectory,
  InMemoryPanelUserRepository,
  SequenceTemporaryPassword,
  TENANTS,
  clientUser,
  staffUser,
} from './panelFakes.js';

function setup(users = []) {
  const userRepository = new InMemoryPanelUserRepository(users);
  const tenantDirectory = new FakeTenantDirectory(TENANTS);
  const useCase = new ManagePanelUsers({
    userRepository,
    tenantDirectory,
    passwordHasher: new FakePasswordHasher(),
    temporaryPasswordGenerator: new SequenceTemporaryPassword(),
  });
  return { userRepository, tenantDirectory, useCase };
}

const FORBIDDEN_FIELDS = ['passwordHash', 'tokenVersion', 'createdBy', 'updatedAt'];

describe('ManagePanelUsers.list', () => {
  it('returns the C6 shape, newest first, with one company lookup per page (C6, C8)', async () => {
    const older = clientUser({ createdAt: new Date('2026-09-01T00:00:00.000Z'), lastLoginAt: new Date('2026-10-11T15:00:00.000Z') });
    const newer = staffUser({ createdAt: new Date('2026-10-01T00:00:00.000Z') });
    const ctx = setup([older, newer]);

    const result = await ctx.useCase.list({});

    expect(result.data.page).toBe(1);
    expect(result.data.pageSize).toBe(25);
    expect(result.data.total).toBe(2);
    expect(result.data.items.map((user) => user.id)).toEqual([newer.id, older.id]);
    expect(result.data.items[1]).toEqual({
      id: older.id,
      email: 'admin@acme.test',
      name: 'Adriana Solís',
      accountType: 'cliente',
      tenantKey: 'sap_integration_acme',
      companyName: 'Acme Industrial',
      role: 'admin',
      active: true,
      mustChangePassword: false,
      lastLoginAt: '2026-10-11T15:00:00.000Z',
      createdAt: '2026-09-01T00:00:00.000Z',
    });
    expect(result.data.items[0]).toEqual(expect.objectContaining({ tenantKey: null, companyName: null, role: null, lastLoginAt: null }));
    result.data.items.forEach((user) => FORBIDDEN_FIELDS.forEach((field) => expect(user).not.toHaveProperty(field)));
    expect(ctx.tenantDirectory.findManyCalls).toBe(1);
  });

  it('filters by tenantKey, case-insensitively', async () => {
    const ctx = setup([clientUser(), staffUser()]);

    const result = await ctx.useCase.list({ tenantKey: 'SAP_INTEGRATION_ACME', page: '1', pageSize: '10' });

    expect(result.data.total).toBe(1);
    expect(result.data.pageSize).toBe(10);
  });

  it.each([
    [{ page: '0' }],
    [{ page: '-1' }],
    [{ page: 'abc' }],
    [{ page: '1.5' }],
    [{ pageSize: '101' }],
    [{ pageSize: '0' }],
  ])('rejects invalid pagination %o', async (query) => {
    const ctx = setup([]);

    const result = await ctx.useCase.list(query);

    expect(result.reason).toBe(panelReasons.VALIDATION_ERROR);
    expect(result.message).toEqual(expect.any(String));
  });
});

describe('ManagePanelUsers.create', () => {
  const actor = { id: 'aaaaaaaaaaaaaaaaaaaaaaaa' };

  it('creates a client user with a temporary password returned once', async () => {
    const ctx = setup([]);

    const result = await ctx.useCase.create({
      actor,
      email: ' Mario@Acme.TEST ',
      name: ' Mario Quesada ',
      accountType: 'cliente',
      tenantKey: 'SAP_INTEGRATION_ACME',
      role: 'usuario',
    });

    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(201);
    expect(result.data.temporaryPassword).toBe('Temporal000001');
    expect(result.data.user).toEqual(expect.objectContaining({
      email: 'mario@acme.test',
      name: 'Mario Quesada',
      tenantKey: 'sap_integration_acme',
      companyName: 'Acme Industrial',
      role: 'usuario',
      mustChangePassword: true,
      active: true,
    }));
    const [stored] = ctx.userRepository.users;
    expect(stored.passwordHash).toBe('hash:Temporal000001');
    expect(stored.createdBy).toBe(actor.id);
    expect(JSON.stringify(result.data.user)).not.toContain('Temporal000001');
  });

  it('creates a smarteam user without tenant or role', async () => {
    const ctx = setup([]);

    const result = await ctx.useCase.create({ email: 'nuevo@smarteam.test', name: 'Nuevo', accountType: 'smarteam' });

    expect(result.ok).toBe(true);
    expect(ctx.userRepository.users[0]).toEqual(expect.objectContaining({ tenantKey: null, role: null, createdBy: null }));
  });

  it('answers email_taken for a duplicated email', async () => {
    const ctx = setup([clientUser()]);

    const result = await ctx.useCase.create({
      email: 'ADMIN@acme.test',
      name: 'Otra',
      accountType: 'cliente',
      tenantKey: 'sap_integration_acme',
      role: 'admin',
    });

    expect(result).toEqual({ ok: false, reason: panelReasons.EMAIL_TAKEN, message: 'Ya existe un usuario con ese correo.' });
  });

  it.each([
    ['an invalid email', { email: 'no-es-correo' }, 'El correo no es válido.'],
    ['an empty name', { name: '   ' }, 'El nombre es obligatorio y puede tener hasta 100 caracteres.'],
    ['a long name', { name: 'a'.repeat(101) }, 'El nombre es obligatorio y puede tener hasta 100 caracteres.'],
    ['an unknown account type', { accountType: 'otro' }, 'El tipo de cuenta no es válido.'],
    ['a client without tenant', { tenantKey: '' }, 'La empresa es obligatoria para una cuenta de cliente.'],
    ['a client with an unknown tenant', { tenantKey: 'sap_integration_nadie' }, 'La empresa no existe.'],
    ['a client without a valid role', { role: 'jefe' }, 'El rol debe ser admin o usuario.'],
    ['a smarteam account with tenant', { accountType: 'smarteam', role: undefined }, 'Las cuentas de Smarteam no llevan empresa ni rol.'],
    ['a smarteam account with role', { accountType: 'smarteam', tenantKey: undefined }, 'Las cuentas de Smarteam no llevan empresa ni rol.'],
  ])('rejects %s', async (_label, overrides, message) => {
    const ctx = setup([]);

    const result = await ctx.useCase.create({
      email: 'mario@acme.test',
      name: 'Mario',
      accountType: 'cliente',
      tenantKey: 'sap_integration_acme',
      role: 'usuario',
      ...overrides,
    });

    expect(result).toEqual({ ok: false, reason: panelReasons.VALIDATION_ERROR, message });
    expect(ctx.userRepository.users).toHaveLength(0);
  });
});

describe('ManagePanelUsers.update', () => {
  it('changes the role without touching tokenVersion', async () => {
    const client = clientUser({ role: 'usuario' });
    const ctx = setup([client]);

    const result = await ctx.useCase.update({ actor: { id: 'x' }, id: client.id, patch: { role: 'admin', name: ' Jefa ' } });

    expect(result.data.user).toEqual(expect.objectContaining({ role: 'admin', name: 'Jefa', companyName: 'Acme Industrial' }));
    expect((await ctx.userRepository.findById(client.id)).tokenVersion).toBe(0);
  });

  it('deactivates a user and bumps tokenVersion to cut open sessions', async () => {
    const client = clientUser();
    const ctx = setup([client]);

    const result = await ctx.useCase.update({ actor: { id: 'x' }, id: client.id, patch: { active: false } });

    expect(result.data.user.active).toBe(false);
    expect((await ctx.userRepository.findById(client.id)).tokenVersion).toBe(1);
  });

  it('reactivates a user without bumping tokenVersion', async () => {
    const client = clientUser({ active: false, tokenVersion: 3 });
    const ctx = setup([client]);

    const result = await ctx.useCase.update({ actor: { id: 'x' }, id: client.id, patch: { active: true } });

    expect(result.data.user.active).toBe(true);
    expect((await ctx.userRepository.findById(client.id)).tokenVersion).toBe(3);
  });

  it('refuses to let someone deactivate their own account (C9)', async () => {
    const staff = staffUser();
    const ctx = setup([staff]);

    const result = await ctx.useCase.update({ actor: { id: staff.id }, id: staff.id, patch: { active: false } });

    expect(result).toEqual({ ok: false, reason: panelReasons.VALIDATION_ERROR, message: 'No puedes desactivar tu propia cuenta.' });
  });

  it.each([
    ['tenantKey', { tenantKey: 'sap_integration_initech' }, 'No se puede cambiar la empresa ni el tipo de cuenta; crea otro usuario.'],
    ['accountType', { accountType: 'smarteam' }, 'No se puede cambiar la empresa ni el tipo de cuenta; crea otro usuario.'],
    ['nothing editable', { foo: 'bar' }, 'No hay cambios para aplicar.'],
    ['a non-boolean active', { active: 'false' }, 'El estado debe ser verdadero o falso.'],
    ['an invalid role', { role: 'jefe' }, 'El rol debe ser admin o usuario.'],
    ['an empty name', { name: '' }, 'El nombre es obligatorio y puede tener hasta 100 caracteres.'],
  ])('rejects a patch with %s', async (_label, patch, message) => {
    const client = clientUser();
    const ctx = setup([client]);

    const result = await ctx.useCase.update({ actor: { id: 'x' }, id: client.id, patch });

    expect(result).toEqual({ ok: false, reason: panelReasons.VALIDATION_ERROR, message });
  });

  it('rejects a role on a smarteam account', async () => {
    const staff = staffUser();
    const ctx = setup([staff]);

    const result = await ctx.useCase.update({ actor: { id: 'x' }, id: staff.id, patch: { role: 'admin' } });

    expect(result.message).toBe('Las cuentas de Smarteam no tienen rol.');
  });

  it('answers not_found for an unknown or malformed id', async () => {
    const ctx = setup([]);

    await expect(ctx.useCase.update({ id: 'ffffffffffffffffffffffff', patch: { name: 'x' } })).resolves.toEqual({
      ok: false,
      reason: panelReasons.NOT_FOUND,
    });
    await expect(ctx.useCase.update({ id: 'no-es-un-id', patch: { name: 'x' } })).resolves.toEqual({
      ok: false,
      reason: panelReasons.NOT_FOUND,
    });
  });
});

describe('ManagePanelUsers.resetPassword', () => {
  it('issues a new temporary password, forces the change and cuts open sessions', async () => {
    const client = clientUser({ tokenVersion: 2 });
    const ctx = setup([client]);

    const result = await ctx.useCase.resetPassword({ actor: { id: 'x' }, id: client.id });

    expect(result).toEqual({ ok: true, data: { temporaryPassword: 'Temporal000001' } });
    expect(await ctx.userRepository.findById(client.id)).toEqual(expect.objectContaining({
      passwordHash: 'hash:Temporal000001',
      mustChangePassword: true,
      tokenVersion: 3,
    }));
  });

  it('refuses a self reset', async () => {
    const staff = staffUser();
    const ctx = setup([staff]);

    const result = await ctx.useCase.resetPassword({ actor: { id: staff.id }, id: staff.id });

    expect(result).toEqual({
      ok: false,
      reason: panelReasons.VALIDATION_ERROR,
      message: 'No puedes restablecer tu propia contraseña desde aquí.',
    });
  });

  it('answers not_found for an unknown id', async () => {
    const ctx = setup([]);

    await expect(ctx.useCase.resetPassword({ actor: { id: 'x' }, id: 'ffffffffffffffffffffffff' })).resolves.toEqual({
      ok: false,
      reason: panelReasons.NOT_FOUND,
    });
  });
});
