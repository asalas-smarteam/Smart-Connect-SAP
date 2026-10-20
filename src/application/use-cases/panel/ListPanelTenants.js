// Empresas para los selectores del panel (contrato C7): sin paginar e incluidos los tenants
// suspendidos e inactivos. El status es el del SaaSClient, no el de la suscripción.
export class ListPanelTenants {
  constructor({ tenantDirectory }) {
    this.tenantDirectory = tenantDirectory;
  }

  async execute() {
    const tenants = await this.tenantDirectory.listAll();
    const items = tenants
      .map(({ tenantKey, companyName, status }) => ({
        tenantKey,
        companyName: companyName ?? null,
        status: status ?? null,
      }))
      .sort((left, right) =>
        String(left.companyName ?? '').localeCompare(String(right.companyName ?? ''), 'es', { sensitivity: 'base' })
      );

    return { ok: true, data: { items } };
  }
}

export default ListPanelTenants;
