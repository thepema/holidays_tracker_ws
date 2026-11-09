import { clearSessionCookie, requireSession, setSessionCookie } from '../lib/security.js';
import { activateSession, recoverSession, requestNewSession, revokeSession } from '../services/sessionService.js';

export default async function authRoutes(app) {
  app.post('/sesiones/activar', async (request, reply) => {
    const { codigo } = request.body || {};
    if (typeof codigo !== 'string' || codigo.length < 20 || codigo.length > 200) {
      return reply.code(400).send({ error: 'Se requiere un código de acceso válido.' });
    }
    try {
      const result = await activateSession(codigo);
      if (!result) return reply.code(401).send({ error: 'El código no es válido o ya fue utilizado.' });
      setSessionCookie(reply, result.token);
      return { usuario: result.user };
    } catch (error) {
      request.log.error({ err: error }, 'No se pudo activar la sesión');
      return reply.code(503).send({ error: 'No se pudo activar la sesión.' });
    }
  });

  app.post('/sesiones/recuperar', async (request, reply) => {
    const { email, codigoRecuperacion } = request.body || {};
    if (typeof email !== 'string' || typeof codigoRecuperacion !== 'string' || !email.trim() || !codigoRecuperacion) {
      return reply.code(400).send({ error: 'Se requieren email y codigoRecuperacion.' });
    }
    try {
      const result = await recoverSession(email, codigoRecuperacion);
      if (!result) return reply.code(401).send({ error: 'Los datos de recuperación no son válidos.' });
      setSessionCookie(reply, result.token);
      return { usuario: result.user };
    } catch (error) {
      request.log.error({ err: error }, 'No se pudo recuperar la sesión');
      return reply.code(503).send({ error: 'No se pudo recuperar la sesión.' });
    }
  });

  app.post('/sesiones/solicitar', { preHandler: requireSession }, async (request, reply) => {
    try {
      await requestNewSession(request.user);
      clearSessionCookie(reply);
      return reply.code(202).send({ mensaje: 'Solicitud enviada al administrador.' });
    } catch (error) {
      request.log.error({ err: error }, 'No se pudo enviar la solicitud de sesión');
      return reply.code(503).send({ error: 'No se pudo enviar la solicitud al administrador.' });
    }
  });

  app.post('/sesiones/cerrar', { preHandler: requireSession }, async (request, reply) => {
    await revokeSession(request.user.id);
    clearSessionCookie(reply);
    return { cerrado: true };
  });
}
