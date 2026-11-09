import { requireAdmin } from '../lib/security.js';
import { createUser, findUserById, listUsersWithoutActiveSession } from '../services/userService.js';
import { inviteUsersWithoutActiveSession, issueInvitation } from '../services/sessionService.js';

export default async function adminRoutes(app) {
  app.post('/usuarios', { preHandler: requireAdmin }, async (request, reply) => {
    const input = request.body || {};
    const required = ['nombre', 'apellidos', 'cargo', 'email', 'tipo_vacaciones'];
    if (required.some((key) => typeof input[key] !== 'string' || !input[key].trim())) {
      return reply.code(400).send({ error: `Se requieren estos campos: ${required.join(', ')}.` });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) {
      return reply.code(400).send({ error: 'El email no tiene un formato válido.' });
    }
    try {
      const user = await createUser(input);
      return reply.code(201).send({ usuario: user });
    } catch (error) {
      if (error.code === '23505') return reply.code(409).send({ error: 'Ya existe un usuario con ese email.' });
      if (error.code === '23514') return reply.code(400).send({ error: 'Los datos del usuario no son válidos.' });
      throw error;
    }
  });

  app.post('/sesiones/invitaciones', { preHandler: requireAdmin }, async () => {
    const users = await listUsersWithoutActiveSession();
    const result = await inviteUsersWithoutActiveSession(users);
    return { total: users.length, enviadas: result.sent, fallidas: result.failed };
  });

  app.post('/usuarios/:usuarioId/invitacion', { preHandler: requireAdmin }, async (request, reply) => {
    const user = await findUserById(request.params.usuarioId);
    if (!user) return reply.code(404).send({ error: 'Usuario no encontrado.' });
    try {
      await issueInvitation(user);
      return { enviada: true };
    } catch {
      return reply.code(503).send({ error: 'No se pudo enviar la invitación. Revisa la configuración de correo.' });
    }
  });
}
