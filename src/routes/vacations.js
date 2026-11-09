import { requireSession } from '../lib/security.js';
import { createVacations, listVacations } from '../services/vacationService.js';

export default async function vacationRoutes(app) {
  app.get('/vacaciones', { preHandler: requireSession }, async (request) => ({
    vacaciones: await listVacations(request.user.id),
  }));

  app.post('/vacaciones', { preHandler: requireSession }, async (request, reply) => {
    const { fechas } = request.body || {};
    const result = await createVacations(request.user.id, fechas);
    if (result.invalid) {
      return reply.code(400).send({ error: 'fechas debe ser una lista de 1 a 366 fechas válidas con formato YYYY-MM-DD.' });
    }
    return reply.code(201).send({ guardadas: result.inserted.length, vacaciones: result.inserted });
  });
}
