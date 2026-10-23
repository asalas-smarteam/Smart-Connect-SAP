// sapCallRecorder.wrap intercepta `request(sapConfig, options)`, que es la firma del
// transporte de B1. El de S/4 recibe UN objeto (`{method, path, query, headers, body}`), así
// que necesita su propio envoltorio o el tráfico de S/4 no queda en el audit trail.
// Mismo truco de Object.create: preserva el prototipo y los `this.request` internos.
export function wrapS4TransportWithRecorder(transport, sapCallRecorder) {
  if (!transport?.request || typeof sapCallRecorder?.record !== 'function') {
    return transport;
  }

  // El transporte agrega los `params` de las credenciales (p. ej. sap-client) a cada URL; se
  // graban junto con la query para que la llamada registrada muestre lo que se envió de verdad.
  // La query de la llamada gana sobre el param por defecto, igual que en el transporte.
  const recordedParams = (query) => {
    const merged = { ...transport.defaultParams, ...query };
    return Object.keys(merged).length ? merged : null;
  };

  return Object.create(transport, {
    request: {
      value: function requestWithAudit(options = {}) {
        return sapCallRecorder.record(
          {
            method: options.method,
            path: options.path,
            params: recordedParams(options.query),
            data: options.body ?? null,
          },
          () => transport.request(options)
        );
      },
    },
  });
}

export default wrapS4TransportWithRecorder;
