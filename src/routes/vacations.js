import { requireSession } from '../lib/security.js';
import { createVacations, listVacations } from '../services/vacationService.js';

const sessionSecurity = [{ SessionCookie: [] }];

export default async function vacationRoutes(app) {
  app.get('/vacaciones', {
    preHandler: requireSession,
    schema: {
      tags: ['Vacaciones'],
      summary: 'Consultar las vacaciones del usuario autenticado',
      security: sessionSecurity,
    },
  }, async (request) => ({
    vacaciones: await listVacations(request.user.id),
  }));

  app.post('/vacaciones', {
    preHandler: requireSession,
    schema: {
      tags: ['Vacaciones'],
      summary: 'Registrar fechas de vacaciones',
      description: 'Acepta entre 1 y 366 fechas con formato YYYY-MM-DD. Las fechas ya guardadas se ignoran.',
      security: sessionSecurity,
      body: {
        type: 'object',
        required: ['fechas'],
        properties: {
          fechas: {
            type: 'array',
            minItems: 1,
            maxItems: 366,
            items: { type: 'string', format: 'date' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { fechas } = request.body || {};
    const result = await createVacations(request.user.id, fechas);
    if (result.invalid) {
      return reply.code(400).send({ error: 'fechas debe ser una lista de 1 a 366 fechas válidas con formato YYYY-MM-DD.' });
    }
    return reply.code(201).send({ guardadas: result.inserted.length, vacaciones: result.inserted });
  });
}
