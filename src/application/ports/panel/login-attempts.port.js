import { createPort } from '../port-validator.js';

export const LoginAttemptsPort = createPort({
  name: 'LoginAttemptsPort',
  methods: [
    // Cuenta el intento ANTES de verificar la contraseña y devuelve { blocked, firstBlocked }
    // (firstBlocked: es el primer intento bloqueado de la ventana). Contar primero
    // evita que una ráfaga de logins en paralelo pase toda junta antes del primer fallo.
    'consume',
    'reset',
  ],
});
