export function createHealthController({ getHealthStatus }) {
  return async function health(_req, reply) {
    const payload = await getHealthStatus.execute();
    return reply.send(payload);
  };
}

export default createHealthController;

