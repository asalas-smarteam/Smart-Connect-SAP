// Tipo real de una imagen según sus primeros bytes. Solo PNG, JPEG y WebP (spec §2 Imágenes):
// nunca SVG, que puede llevar scripts. No se confía en la extensión ni en el Content-Type.
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

export const IMAGE_EXTENSIONS = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
});

function startsWith(bytes, signature, offset = 0) {
  if (!bytes || bytes.length < offset + signature.length) {
    return false;
  }
  return signature.every((value, index) => bytes[offset + index] === value);
}

// bytes: Buffer o Uint8Array. Devuelve el tipo MIME o null.
export function detectImageType(bytes) {
  if (startsWith(bytes, PNG)) {
    return 'image/png';
  }
  if (startsWith(bytes, JPEG)) {
    return 'image/jpeg';
  }
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) {
    return 'image/webp';
  }
  return null;
}

// Nombre de archivo para mostrar: sin rutas, sin caracteres de control y acotado.
export function safeAttachmentFilename(name, contentType) {
  const base = String(name ?? '')
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f\u007f"<>]/g, '')
    .trim()
    .slice(0, 150);
  if (base) {
    return base;
  }
  return `imagen.${IMAGE_EXTENSIONS[contentType] ?? 'png'}`;
}
