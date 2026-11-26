import mcpPlugin from '@platformatic/mcp';
import { Type } from '@sinclair/typebox';
import { authenticateMcpApiKey } from '../services/sessionService.js';
import { findUserById } from '../services/userService.js';
import {
  createVacations,
  deleteVacation,
  listVacations,
  updateVacationDate,
} from '../services/vacationService.js';
import { listHolidaysForUser } from '../services/officeService.js';

function jsonContent(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

function errorContent(message, details = undefined) {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          details ? { error: message, ...details } : { error: message },
          null,
          2,
        ),
      },
    ],
  };
}

function getTodayDateKey() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function extractApiKeyHeader(request) {
  const raw = request.headers['x-api-key'] ?? request.headers['api-key'];
  if (Array.isArray(raw)) {
    return typeof raw[0] === 'string' ? raw[0].trim() : '';
  }
  return typeof raw === 'string' ? raw.trim() : '';
}

function getAuthenticatedMcpUser(context) {
  return context?.request?.mcpUser || null;
}

export default async function mcpVacationsPlugin(app) {
  if (!app.hasRequestDecorator('mcpUser')) {
    app.decorateRequest('mcpUser', null);
  }

  // Encapsulado en este plugin: aplica exclusivamente a las rutas /mcp
  app.addHook('preHandler', async (request, reply) => {
    const authHeader = String(request.headers.authorization || '').trim();
    if (/^Bearer\s+/i.test(authHeader)) {
      return reply.code(401).send({
        error:
          'La autenticación Bearer no está permitida en el servicio MCP. Envía tu API token de usuario en la cabecera x-api-key.',
      });
    }

    const apiKey = extractApiKeyHeader(request);
    if (!apiKey) {
      return reply.code(401).send({
        error:
          'API key requerida. Obtén tu API token en el dashboard de usuario y envíalo en la cabecera x-api-key.',
      });
    }

    const mcpUser = await authenticateMcpApiKey(apiKey);
    if (!mcpUser) {
      return reply.code(401).send({
        error: 'API key inválida o sesión de usuario revocada/inactiva.',
      });
    }

    request.mcpUser = mcpUser;
  });

  await app.register(mcpPlugin, {
    serverInfo: {
      name: 'holidays-tracker-mcp',
      version: '1.0.0',
    },
    capabilities: {
      tools: { listChanged: true },
    },
    enableSSE: true,
    transformRouteSchema: (schema) => ({
      ...schema,
      tags: ['MCP'],
      security: [{ McpApiKeyAuth: [] }],
    }),
    instructions:
      'Servidor MCP de Holiday Tracker autenticado por API key de usuario (cabecera x-api-key). Permite consultar y gestionar exclusivamente las vacaciones y festivos del usuario propietario de la API key.',
  });

  app.mcpAddTool(
    {
      name: 'consultar_perfil',
      description:
        'Obtiene la información del perfil del usuario autenticado mediante su API key.',
      inputSchema: Type.Object({}),
    },
    async (_params, context) => {
      const mcpUser = getAuthenticatedMcpUser(context);
      if (!mcpUser) {
        return errorContent('Usuario no autenticado.');
      }

      const profile = await findUserById(mcpUser.id);
      return jsonContent({ usuario: profile || mcpUser });
    },
  );

  app.mcpAddTool(
    {
      name: 'listar_vacaciones',
      description:
        'Lista los días de vacaciones registrados del usuario autenticado, con filtros opcionales por año y mes.',
      inputSchema: Type.Object({
        anio: Type.Optional(
          Type.Integer({ minimum: 1900, maximum: 2200, description: 'Año (YYYY)' }),
        ),
        mes: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 12, description: 'Mes (1-12)' }),
        ),
      }),
    },
    async (params, context) => {
      const mcpUser = getAuthenticatedMcpUser(context);
      if (!mcpUser) {
        return errorContent('Usuario no autenticado.');
      }

      const vacaciones = await listVacations([mcpUser.id], {
        anio: params.anio,
        mes: params.mes,
      });

      return jsonContent({ total: vacaciones.length, vacaciones });
    },
  );

  app.mcpAddTool(
    {
      name: 'registrar_vacaciones',
      description:
        'Registra entre 1 y 366 fechas futuras o de hoy (YYYY-MM-DD) como vacaciones para el usuario autenticado, validando conflictos con festivos de su oficina.',
      inputSchema: Type.Object({
        fechas: Type.Array(
          Type.String({
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
            description: 'Fecha en formato YYYY-MM-DD',
          }),
          { minItems: 1, maxItems: 366 },
        ),
      }),
    },
    async (params, context) => {
      const mcpUser = getAuthenticatedMcpUser(context);
      if (!mcpUser) {
        return errorContent('Usuario no autenticado.');
      }

      const todayKey = getTodayDateKey();
      const pastDates = params.fechas.filter((f) => f < todayKey);
      if (pastDates.length > 0) {
        return errorContent(
          `No se pueden registrar vacaciones en fechas pasadas: ${pastDates.join(', ')}.`,
          { fechasPasadas: pastDates },
        );
      }

      try {
        const result = await createVacations(mcpUser.id, params.fechas);
        if (result.invalid) {
          return errorContent(
            'fechas debe ser una lista de 1 a 366 fechas válidas con formato YYYY-MM-DD.',
          );
        }
        if (result.holidayConflict) {
          const lista = result.holidays
            .map((h) => `${h.fecha} (${h.nombre})`)
            .join(', ');
          return errorContent(
            `No se pueden registrar vacaciones en días festivos de la oficina asignada: ${lista}.`,
            { festivos: result.holidays },
          );
        }
        return jsonContent({
          guardadas: result.inserted.length,
          vacaciones: result.inserted,
        });
      } catch (error) {
        if (error.code === '23503') {
          return errorContent('Usuario no encontrado.');
        }
        throw error;
      }
    },
  );

  app.mcpAddTool(
    {
      name: 'modificar_vacacion',
      description:
        'Modifica la fecha de un día de vacaciones propio del usuario autenticado (si aún no ha pasado ni coincide con festivos).',
      inputSchema: Type.Object({
        vacacionId: Type.Integer({
          minimum: 1,
          description: 'ID del registro de vacación a modificar',
        }),
        nuevaFecha: Type.String({
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          description: 'Nueva fecha en formato YYYY-MM-DD',
        }),
      }),
    },
    async (params, context) => {
      const mcpUser = getAuthenticatedMcpUser(context);
      if (!mcpUser) {
        return errorContent('Usuario no autenticado.');
      }

      const result = await updateVacationDate(
        params.vacacionId,
        mcpUser.id,
        params.nuevaFecha,
        false,
      );

      if (result.invalid) {
        return errorContent('La nueva fecha debe tener formato válido YYYY-MM-DD.');
      }
      if (result.pastTargetDate) {
        return errorContent(
          'No puedes cambiar un día de vacaciones a una fecha que ya ha pasado.',
        );
      }
      if (result.notFound) {
        return errorContent('Día de vacaciones no encontrado.');
      }
      if (result.forbidden) {
        return errorContent('No tienes permiso para modificar este día de vacaciones.');
      }
      if (result.pastDate) {
        return errorContent(
          'No se pueden modificar días de vacaciones cuya fecha ya ha pasado.',
        );
      }
      if (result.holidayConflict) {
        return errorContent(
          `No puedes mover las vacaciones al ${params.nuevaFecha} porque es día festivo en tu oficina (${result.holiday.nombre}).`,
          { festivo: result.holiday },
        );
      }
      if (result.duplicate) {
        return errorContent('Ya tienes registrado ese día de vacaciones.');
      }

      return jsonContent({ vacacion: result.updated });
    },
  );

  app.mcpAddTool(
    {
      name: 'eliminar_vacacion',
      description:
        'Elimina o cancela un día de vacaciones propio del usuario autenticado (si aún no ha pasado).',
      inputSchema: Type.Object({
        vacacionId: Type.Integer({
          minimum: 1,
          description: 'ID del registro de vacación a eliminar',
        }),
      }),
    },
    async (params, context) => {
      const mcpUser = getAuthenticatedMcpUser(context);
      if (!mcpUser) {
        return errorContent('Usuario no autenticado.');
      }

      const result = await deleteVacation(params.vacacionId, mcpUser.id, false);

      if (result.notFound) {
        return errorContent('Día de vacaciones no encontrado.');
      }
      if (result.forbidden) {
        return errorContent('No tienes permiso para eliminar este día de vacaciones.');
      }
      if (result.pastDate) {
        return errorContent(
          'No se pueden eliminar días de vacaciones cuya fecha ya ha pasado.',
        );
      }

      return jsonContent({ eliminado: true, id: result.id });
    },
  );

  app.mcpAddTool(
    {
      name: 'consultar_festivos',
      description:
        'Consulta los días festivos de la oficina del usuario autenticado, con filtros opcionales por año y mes.',
      inputSchema: Type.Object({
        anio: Type.Optional(
          Type.Integer({ minimum: 1900, maximum: 2200, description: 'Año (YYYY)' }),
        ),
        mes: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 12, description: 'Mes (1-12)' }),
        ),
      }),
    },
    async (params, context) => {
      const mcpUser = getAuthenticatedMcpUser(context);
      if (!mcpUser) {
        return errorContent('Usuario no autenticado.');
      }

      let festivos = await listHolidaysForUser(mcpUser.id);
      if (params.anio !== undefined) {
        festivos = festivos.filter((h) => h.anio === params.anio);
      }
      if (params.mes !== undefined) {
        festivos = festivos.filter((h) => Number(h.fecha.slice(5, 7)) === params.mes);
      }

      return jsonContent({
        oficinaId: mcpUser.oficinaId ?? null,
        oficinaNombre: mcpUser.oficinaNombre ?? null,
        total: festivos.length,
        festivos,
      });
    },
  );
}
