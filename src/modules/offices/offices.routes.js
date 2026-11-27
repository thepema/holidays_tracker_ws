import { appError } from '../../shared/errors.js';
import { requireAdmin, requireAdminOrSession } from '../../shared/security.js';
import {
  addOfficeHoliday,
  createOffice,
  createOfficeCalendar,
  deleteOffice,
  deleteOfficeCalendar,
  deleteOfficeHoliday,
  listAllHolidays,
  listHolidaysForUser,
  listOffices,
  updateOffice,
} from './offices.service.js';

const adminSecurity = [{ AdminBearerAuth: [] }];
const holidaySecurity = [{ AdminBearerAuth: [] }, { SessionCookie: [] }];

export default async function officesRoutes(app) {
  app.get('/festivos', {
    preHandler: requireAdminOrSession,
    schema: {
      tags: ['Vacaciones'],
      summary: 'Consultar días festivos de la oficina del usuario o filtrados (admin)',
      security: holidaySecurity,
      querystring: {
        type: 'object',
        properties: {
          oficinaId: { type: 'integer', minimum: 1 },
          equipoId: { type: 'integer', minimum: 1 },
          anio: { type: 'integer', minimum: 1900, maximum: 2200 },
          mes: { type: 'integer', minimum: 1, maximum: 12 },
        },
      },
    },
  }, async (request) => {
    if (request.isAdmin) {
      const { oficinaId, equipoId, anio, mes } = request.query || {};
      return {
        festivos: await listAllHolidays({ oficinaId, equipoId, anio, mes }),
      };
    }
    return {
      oficinaId: request.user.oficinaId ?? null,
      oficinaNombre: request.user.oficinaNombre ?? null,
      festivos: await listHolidaysForUser(request.user.id),
    };
  });

  app.get('/oficinas', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Oficinas'],
      summary: 'Obtener todas las oficinas con sus calendarios y festivos',
      security: adminSecurity,
    },
  }, async () => {
    const oficinas = await listOffices();
    return { oficinas };
  });

  app.post('/oficinas', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Oficinas'],
      summary: 'Crear una oficina',
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
      throw appError('OFFICE_NAME_REQUIRED');
    }
    const { office } = await createOffice({ nombre, usuarioIds });
    return reply.code(201).send({ oficina: office });
  });

  app.patch('/oficinas/:oficinaId', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Oficinas'],
      summary: 'Actualizar una oficina y/o sus usuarios asignados',
      security: adminSecurity,
      params: {
        type: 'object',
        required: ['oficinaId'],
        properties: { oficinaId: { type: 'integer', minimum: 1 } },
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
    const { oficinaId } = request.params;
    const { nombre, usuarioIds } = request.body || {};
    if (nombre !== undefined && (typeof nombre !== 'string' || !nombre.trim())) {
      throw appError('OFFICE_NAME_EMPTY');
    }
    const { office } = await updateOffice(oficinaId, { nombre, usuarioIds });
    return { oficina: office };
  });

  app.delete('/oficinas/:oficinaId', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Oficinas'],
      summary: 'Eliminar una oficina',
      security: adminSecurity,
      params: {
        type: 'object',
        required: ['oficinaId'],
        properties: { oficinaId: { type: 'integer', minimum: 1 } },
      },
    },
  }, async (request) => {
    const { oficinaId } = request.params;
    const result = await deleteOffice(oficinaId);
    return { eliminado: true, id: result.id };
  });

  app.post('/oficinas/:oficinaId/calendarios', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Oficinas'],
      summary: 'Crear o asegurar un calendario anual para una oficina',
      security: adminSecurity,
      params: {
        type: 'object',
        required: ['oficinaId'],
        properties: { oficinaId: { type: 'integer', minimum: 1 } },
      },
      body: {
        type: 'object',
        required: ['anio'],
        properties: {
          anio: { type: 'integer', minimum: 1900, maximum: 2200 },
        },
      },
    },
  }, async (request, reply) => {
    const { oficinaId } = request.params;
    const { anio } = request.body || {};
    const { office } = await createOfficeCalendar(oficinaId, anio);
    return reply.code(201).send({ oficina: office });
  });

  app.delete('/oficinas/:oficinaId/calendarios/:calendarioId', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Oficinas'],
      summary: 'Eliminar un calendario anual y sus días festivos',
      security: adminSecurity,
      params: {
        type: 'object',
        required: ['oficinaId', 'calendarioId'],
        properties: {
          oficinaId: { type: 'integer', minimum: 1 },
          calendarioId: { type: 'integer', minimum: 1 },
        },
      },
    },
  }, async (request) => {
    const { oficinaId, calendarioId } = request.params;
    const { office } = await deleteOfficeCalendar(oficinaId, calendarioId);
    return { eliminado: true, oficina: office };
  });

  app.post('/oficinas/:oficinaId/festivos', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Oficinas'],
      summary: 'Añadir un día festivo a una oficina',
      security: adminSecurity,
      params: {
        type: 'object',
        required: ['oficinaId'],
        properties: { oficinaId: { type: 'integer', minimum: 1 } },
      },
      body: {
        type: 'object',
        required: ['fecha', 'nombre'],
        properties: {
          fecha: { type: 'string', format: 'date' },
          nombre: { type: 'string', minLength: 1, maxLength: 120 },
          anio: { type: 'integer', minimum: 1900, maximum: 2200 },
        },
      },
    },
  }, async (request, reply) => {
    const { oficinaId } = request.params;
    const { fecha, nombre, anio } = request.body || {};
    const { office } = await addOfficeHoliday(oficinaId, { fecha, nombre, anio });
    return reply.code(201).send({ oficina: office });
  });

  app.delete('/oficinas/:oficinaId/festivos/:festivoId', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Oficinas'],
      summary: 'Eliminar un día festivo de una oficina',
      security: adminSecurity,
      params: {
        type: 'object',
        required: ['oficinaId', 'festivoId'],
        properties: {
          oficinaId: { type: 'integer', minimum: 1 },
          festivoId: { type: 'integer', minimum: 1 },
        },
      },
    },
  }, async (request) => {
    const { oficinaId, festivoId } = request.params;
    const result = await deleteOfficeHoliday(oficinaId, festivoId);
    return { eliminado: true, id: result.id, oficina: result.office };
  });
}
