import multipart from '@fastify/multipart';
import { TICKET_LIMITS } from '#domain/panel/tickets.js';

const IMAGES_FIELD = 'images';
const MAX_TEXT_BYTES = 64 * 1024;
// Tope del cuerpo completo: 5 imágenes de 5 MB más los textos y los encabezados de cada parte.
// Si el Content-Length ya lo supera, se rechaza sin leer nada.
export const MAX_FORM_BYTES = TICKET_LIMITS.MAX_IMAGES * TICKET_LIMITS.MAX_IMAGE_BYTES + 1024 * 1024;

// Formularios multipart de Soporte (contrato D6). Se registra SOLO dentro del plugin del panel:
// el resto de la API sigue sin aceptar multipart. Los límites se aplican en el parser, mientras
// llega el archivo, no después de leerlo entero.
export async function registerPanelMultipart(app) {
  await app.register(multipart, {
    throwFileSizeLimit: true,
    limits: {
      fileSize: TICKET_LIMITS.MAX_IMAGE_BYTES,
      files: TICKET_LIMITS.MAX_IMAGES,
      fields: 10,
      parts: 20,
      fieldSize: MAX_TEXT_BYTES,
      headerPairs: 100,
    },
  });
}

export class PanelFormError extends Error {
  constructor(message = 'Formulario inválido.') {
    super(message);
    this.name = 'PanelFormError';
    this.code = 'PANEL_INVALID_FORM';
  }
}

// Lee el formulario: textos permitidos (el primero de cada nombre) e imágenes del campo
// `images`, repetido una vez por archivo. La validación de tipo y cantidad la hace el caso de uso.
export async function readTicketForm(req, textFields) {
  if (!req.isMultipart?.()) {
    throw new PanelFormError();
  }
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FORM_BYTES) {
    throw Object.assign(new Error('Panel form too large'), { code: 'FST_REQ_FILE_TOO_LARGE', statusCode: 413 });
  }

  const allowed = new Set(textFields);
  const fields = {};
  const images = [];
  let unexpectedFile = false;

  for await (const part of req.parts()) {
    if (part.type === 'file') {
      if (part.fieldname === IMAGES_FIELD) {
        images.push({ filename: part.filename, data: await part.toBuffer() });
      } else {
        // Un archivo en otro campo no se guarda en memoria: se descarta mientras llega.
        unexpectedFile = true;
        part.file.resume();
      }
      continue;
    }

    if (part.valueTruncated || part.fieldnameTruncated) {
      throw new PanelFormError('Un texto del formulario es demasiado largo.');
    }
    if (allowed.has(part.fieldname) && !(part.fieldname in fields)) {
      fields[part.fieldname] = typeof part.value === 'string' ? part.value : String(part.value ?? '');
    }
  }

  if (unexpectedFile) {
    throw new PanelFormError('Las imágenes van en el campo images.');
  }

  return { fields, images };
}
