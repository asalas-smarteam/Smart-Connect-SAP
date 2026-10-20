// Períodos de los resúmenes (contrato 05, F1, F4, F9): días locales en la zona del usuario,
// semanas desde el lunes y medianas. Con Intl, sin operadores de Mongo 5.0+.

const DAY_MS = 86_400_000;
const MIN_DATE_MS = Date.UTC(2000, 0, 1);
const MAX_DATE_MS = Date.UTC(2100, 0, 1);
const MAX_FORMATTERS = 50;
// 366 días y una hora de margen por los cambios de horario.
export const MAX_PERIOD_MS = 366 * DAY_MS + 3_600_000;

export function isTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch (error) {
    return false;
  }
}

// { from, to, tz } de la query: obligatorios, ISO, to exclusivo y mayor que from.
// Devuelve { from: ms, to: ms, tz } o null.
export function parsePeriod({ from, to, tz } = {}) {
  if (typeof from !== 'string' || typeof to !== 'string') {
    return null;
  }
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || toMs <= fromMs) {
    return null;
  }
  if (toMs - fromMs > MAX_PERIOD_MS || !isTimeZone(tz)) {
    return null;
  }
  // Fechas razonables: el período anterior de igual largo (F8) también debe ser una fecha válida.
  if (fromMs < MIN_DATE_MS || toMs > MAX_DATE_MS) {
    return null;
  }
  return { from: fromMs, to: toMs, tz };
}

const formatters = new Map();

// Fecha local YYYY-MM-DD de un instante (ms) en la zona tz.
export function localDate(ms, tz) {
  if (!formatters.has(tz)) {
    if (formatters.size >= MAX_FORMATTERS) {
      formatters.clear();
    }
    formatters.set(tz, new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }));
  }
  return formatters.get(tz).format(ms);
}

// YYYY-MM-DD más days días (calendario, sin zonas).
export function addDays(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

// Lunes de la semana de una fecha YYYY-MM-DD.
export function mondayOf(date) {
  const [year, month, day] = date.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

// Todos los días locales del período [from, to), en orden.
export function eachLocalDay(from, to, tz) {
  const last = localDate(to - 1, tz);
  const days = [];
  for (let day = localDate(from, tz); day <= last; day = addDays(day, 1)) {
    days.push(day);
  }
  return days;
}

// Mediana redondeada a entero; null sin valores.
export function median(values) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.round(value);
}

export function toMs(value) {
  if (!value) {
    return Number.NaN;
  }
  return value instanceof Date ? value.getTime() : Date.parse(value);
}
