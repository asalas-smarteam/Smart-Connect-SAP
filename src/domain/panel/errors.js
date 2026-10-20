// El repositorio de usuarios del panel lanza este error cuando el correo ya existe, para que el
// caso de uso no dependa del código de error de la base de datos.
export class PanelEmailTakenError extends Error {
  constructor(message = 'Panel user email already exists') {
    super(message);
    this.name = 'PanelEmailTakenError';
    this.code = 'PANEL_EMAIL_TAKEN';
  }
}

// El cálculo de contraseñas del panel está saturado (cola llena). Se responde 429 sin calcular:
// así una ráfaga de logins no acapara los hilos de Node que usan también DNS y archivos.
export class PanelHasherBusyError extends Error {
  constructor(message = 'Panel password hasher is busy') {
    super(message);
    this.name = 'PanelHasherBusyError';
    this.code = 'PANEL_HASHER_BUSY';
  }
}

// Una consulta del panel pasó su tiempo máximo (maxTimeMS). El caso de uso responde pidiendo
// acotar los filtros en vez de un 500.
export class PanelQueryTimeoutError extends Error {
  constructor(message = 'Panel query exceeded its time limit') {
    super(message);
    this.name = 'PanelQueryTimeoutError';
    this.code = 'PANEL_QUERY_TIMEOUT';
  }
}
