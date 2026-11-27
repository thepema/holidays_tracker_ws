import { appError } from '../../shared/errors.js';
import { requireAdmin } from '../../shared/security.js';
import {
  createTeam,
  deleteTeam,
  listTeams,
  updateTeam,
} from './teams.service.js';

const adminSecurity = [{ AdminBearerAuth: [] }];

export default async function teamsRoutes(app) {
  app.get('/equipos', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Equipos'],
      summary: 'Obtener todos los equipos',
      description: 'Devuelve la lista de equipos registrados junto con los IDs de usuarios que pertenecen a cada uno.',
      security: adminSecurity,
    },
  }, async () => {
    const equipos = await listTeams();
    return { equipos };
  });

  app.post('/equipos', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Equipos'],
      summary: 'Crear un equipo',
      description: 'Crea un nuevo equipo y opcionalmente asigna sus miembros iniciales.',
      security: adminSecurity,
      body: {
        type: 'object',
        required: ['nombre'],
        properties: {
          nombre: { type: 'string', minLength: 1, maxLength: 120 },
          usuarioIds: { type: 'array', items: { type: 'integer', minimum: 1 } },
        },
      },
    },
  }, async (request, reply) => {
    const { nombre, usuarioIds } = request.body || {};
    if (typeof nombre !== 'string' || !nombre.trim()) {
      throw appError('TEAM_NAME_REQUIRED');
    }
    const { team } = await createTeam({ nombre, usuarioIds });
    return reply.code(201).send({ equipo: team });
  });

  app.patch('/equipos/:equipoId', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Equipos'],
      summary: 'Actualizar un equipo y/o sus usuarios',
      description: 'Permite renombrar un equipo y/o actualizar la lista de usuarios que pertenecen a él.',
      security: adminSecurity,
      params: {
        type: 'object',
        required: ['equipoId'],
        properties: { equipoId: { type: 'integer', minimum: 1 } },
      },
      body: {
        type: 'object',
        minProperties: 1,
        additionalProperties: false,
        properties: {
          nombre: { type: 'string', minLength: 1, maxLength: 120 },
          usuarioIds: { type: 'array', items: { type: 'integer', minimum: 1 } },
        },
      },
    },
  }, async (request) => {
    const { equipoId } = request.params;
    const { nombre, usuarioIds } = request.body || {};
    if (nombre !== undefined && (typeof nombre !== 'string' || !nombre.trim())) {
      throw appError('TEAM_NAME_EMPTY');
    }
    const { team } = await updateTeam(equipoId, { nombre, usuarioIds });
    return { equipo: team };
  });

  app.delete('/equipos/:equipoId', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Equipos'],
      summary: 'Eliminar un equipo',
      description: 'Elimina el equipo y desvincula a todos los usuarios asignados a él.',
      security: adminSecurity,
      params: {
        type: 'object',
        required: ['equipoId'],
        properties: { equipoId: { type: 'integer', minimum: 1 } },
      },
    },
  }, async (request) => {
    const { equipoId } = request.params;
    const result = await deleteTeam(equipoId);
    return { eliminado: true, id: result.id };
  });
}
