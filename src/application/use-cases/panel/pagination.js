import { validationError } from './panelReasons.js';

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    return Number.NaN;
  }

  return Number(text);
}

// Paginación de todas las listas del panel: ?page=1&pageSize=25, pageSize máximo 100.
export function parsePagination({ page, pageSize } = {}) {
  const parsedPage = parsePositiveInteger(page, 1);
  const parsedPageSize = parsePositiveInteger(pageSize, DEFAULT_PAGE_SIZE);

  if (!Number.isSafeInteger(parsedPage) || parsedPage < 1) {
    return validationError('La página debe ser un número entero mayor o igual a 1.');
  }

  if (!Number.isSafeInteger(parsedPageSize) || parsedPageSize < 1 || parsedPageSize > MAX_PAGE_SIZE) {
    return validationError(`El tamaño de página debe ser un número entero entre 1 y ${MAX_PAGE_SIZE}.`);
  }

  return { ok: true, page: parsedPage, pageSize: parsedPageSize };
}
