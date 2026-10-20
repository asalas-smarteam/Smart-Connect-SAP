// Vista de un mapeo de campos para el panel (plan 6, contrato 08, I2). Igual para cliente y
// Smarteam: no hay nada que sanear. Nunca expone clientConfigId ni hubspotCredentialId.

// Si el documento no trae el campo, el valor por defecto del esquema FieldMapping: es lo que ve
// la integración al leerlo con Mongoose.
const BOOLEAN_DEFAULTS = Object.freeze({
  isActive: true,
  editable: true,
  includeInServiceLayerSelect: true,
  userField: false,
});

function text(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return String(value);
}

function flag(raw, name) {
  return typeof raw[name] === 'boolean' ? raw[name] : BOOLEAN_DEFAULTS[name];
}

export function toFieldMappingView(raw) {
  if (!raw) {
    return null;
  }
  const id = raw._id ?? raw.id;
  return {
    id: id === undefined || id === null ? null : String(id),
    sourceField: text(raw.sourceField),
    targetField: text(raw.targetField),
    objectType: text(raw.objectType),
    sourceContext: text(raw.sourceContext),
    isActive: flag(raw, 'isActive'),
    editable: flag(raw, 'editable'),
    // Nombre genérico de includeInServiceLayerSelect (regla de nombres del contrato).
    includeInSourceQuery: flag(raw, 'includeInServiceLayerSelect'),
    userField: flag(raw, 'userField'),
  };
}
