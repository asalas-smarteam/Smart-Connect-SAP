// scripts/create-panel-staff.mjs
//
// Crea la primera cuenta de Smarteam del panel de soporte (/panel/api). Las demás cuentas se
// crean desde el propio panel (Usuarios). La cuenta queda con una contraseña temporal y con el
// cambio de contraseña obligatorio en el primer ingreso.
//
// Imprime en stdout SOLO la contraseña temporal; los mensajes van a stderr. La temporal no se
// guarda en claro en ningún lado: si se pierde, otra cuenta de Smarteam la restablece desde el
// panel (o se borra el usuario a mano y se vuelve a correr el script).
//
// Si el correo ya existe, no toca la cuenta y sale con código 1.
//
// Uso:
//   node --env-file=.env scripts/create-panel-staff.mjs <email> "<nombre>"
// En producción (el contenedor ya tiene el .env):
//   docker compose exec api node scripts/create-panel-staff.mjs <email> "<nombre>"
import { connect, disconnect } from '../src/infrastructure/database/master/database.js';
import { buildManagePanelUsers } from '../src/composition/panel.composition.js';

const [, , email, ...nameParts] = process.argv;
const name = nameParts.join(' ').trim();

function usage(message) {
  console.error(message);
  console.error('Uso: node --env-file=.env scripts/create-panel-staff.mjs <email> "<nombre>"');
  process.exit(1);
}

if (!email || !name) {
  usage('Faltan el correo o el nombre.');
}

// connect() de la master escribe "Database connected" con console.info (stdout). Se manda a
// stderr para que stdout lleve solo la contraseña temporal y se pueda capturar en un script.
console.info = (...args) => console.error(...args);

let exitCode = 0;

try {
  await connect();
  const result = await buildManagePanelUsers().create({
    actor: null,
    source: 'script',
    email,
    name,
    accountType: 'smarteam',
  });

  if (result.ok) {
    console.error(`Cuenta de Smarteam creada para ${result.data.user.email}. Contraseña temporal:`);
    console.log(result.data.temporaryPassword);
  } else {
    console.error(`No se creó la cuenta: ${result.message ?? result.reason}`);
    exitCode = 1;
  }
} catch (error) {
  console.error(`No se creó la cuenta: ${error.message}`);
  exitCode = 1;
} finally {
  await disconnect().catch(() => {});
}

process.exit(exitCode);
