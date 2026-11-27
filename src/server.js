import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import authRoutes from './modules/auth/auth.routes.js';
import usersRoutes from './modules/users/users.routes.js';
import teamsRoutes from './modules/teams/teams.routes.js';
import officesRoutes from './modules/offices/offices.routes.js';
import vacationsRoutes from './modules/vacations/vacations.routes.js';
import mcpModule from './modules/mcp/index.js';
import { AppError, ERROR_CATALOG } from './shared/errors.js';
import { authenticateSession } from './modules/auth/session.service.js';

const app = Fastify({ logger: true });
const SESSION_COOKIE_NAME = 'ht_session';

const isTrustedOrigin = (origin) => {
  if (!origin) return true;
  try {
    const { protocol, hostname } = new URL(origin);
    return protocol === 'https:' &&
      (hostname === 'maisonzaro.com' || hostname.endsWith('.maisonzaro.com'));
  } catch {
    return false;
  }
};

const localOrigins = new Set([
  'http://localhost:4200',
  'http://127.0.0.1:4200',
  ...(process.env.FRONTEND_ORIGIN ? [process.env.FRONTEND_ORIGIN] : []),
]);

function isPublicMcpOrOAuthCorsPath(rawUrl = '') {
  return (
    rawUrl === '/mcp' ||
    rawUrl.startsWith('/mcp?') ||
    rawUrl.startsWith('/.well-known/') ||
    rawUrl.startsWith('/oauth/register') ||
    rawUrl.startsWith('/oauth/token') ||
    rawUrl.startsWith('/oauth/revoke')
  );
}

await app.register(cors, {
  delegator: (req, callback) => {
    if (isPublicMcpOrOAuthCorsPath(req.url)) {
      return callback(null, {
        origin: true,
        credentials: false,
        methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
        allowedHeaders: [
          'Content-Type',
          'Authorization',
          'Accept',
          'Last-Event-ID',
          'Mcp-Session-Id',
          'MCP-Protocol-Version',
          'x-api-key',
          'api-key',
        ],
        exposedHeaders: ['Mcp-Session-Id', 'WWW-Authenticate'],
      });
    }

    return callback(null, {
      origin: (origin, originCb) =>
        originCb(null, isTrustedOrigin(origin) || localOrigins.has(origin)),
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    });
  },
});
await app.register(cookie);

// Register Swagger before API routes so Fastify can collect their schemas.
await app.register(swagger, {
  openapi: {
    openapi: '3.0.3',
    info: {
      title: 'Holiday Tracker API',
      description: 'API para administrar usuarios, sesiones y vacaciones.',
      version: '1.0.0',
    },
    servers: [{ url: '/', description: 'Servidor actual' }],
    components: {
      securitySchemes: {
        AdminBearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Token Bearer obtenido en POST /api/admin/login.',
        },
        SessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: SESSION_COOKIE_NAME,
          description: 'Cookie establecida al activar o recuperar una sesión de usuario.',
        },
        McpApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'x-api-key',
          description: 'API Token personal del usuario (token_hash de su sesión activa) obtenido desde su dashboard.',
        },
        McpOAuthBearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Access token virtual OAuth 2.1 emitido en /oauth/token a partir de la API Key del usuario.',
        },
      },
    },
  },
});

await app.register(swaggerUi, {
  routePrefix: '/docs',
  uiConfig: {
    docExpansion: 'list',
    deepLinking: true,
    persistAuthorization: true,
    withCredentials: true,
  },
});

app.decorateRequest('user', null);
app.decorateRequest('isAdmin', false);

app.get('/', async () => ({ message: 'Holiday Tracker API' }));

app.addHook('preHandler', async (request) => {
  if (
    request.url === '/mcp' ||
    request.url.startsWith('/mcp?') ||
    request.url.startsWith('/oauth/') ||
    request.url.startsWith('/.well-known/')
  ) {
    return;
  }
  const headerToken = request.headers['x-session-token'];
  const token =
    request.cookies?.[SESSION_COOKIE_NAME] ||
    (typeof headerToken === 'string' && headerToken.trim() ? headerToken.trim() : '');
  if (token) request.user = await authenticateSession(token);
});

app.setErrorHandler((error, request, reply) => {
  if (error instanceof AppError || (error?.key && ERROR_CATALOG[error.key])) {
    if (error.headers) {
      for (const [headerName, headerValue] of Object.entries(error.headers)) {
        reply.header(headerName, headerValue);
      }
    }
    if (error.statusCode >= 500 && error.cause) {
      request.log.error({ err: error.cause }, error.message);
    }
    return reply.code(error.statusCode).send({
      error: error.message,
      ...error.extraBody,
    });
  }
  if (error.statusCode === 429) {
    if (error.retryAfterSeconds) {
      reply.header('Retry-After', String(error.retryAfterSeconds));
    }
    return reply.code(429).send({
      error: error.message,
      ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    });
  }
  if (error.validation || error.statusCode === 400) {
    return reply.code(400).send({ error: 'Datos de entrada no válidos.' });
  }
  request.log.error({ err: error }, 'Error no controlado en la API');
  return reply.code(500).send({ error: 'Error interno del servidor.' });
});

await app.register(authRoutes, { prefix: '/api' });
await app.register(usersRoutes, { prefix: '/api' });
await app.register(teamsRoutes, { prefix: '/api' });
await app.register(officesRoutes, { prefix: '/api' });
await app.register(vacationsRoutes, { prefix: '/api' });
await app.register(mcpModule);

const start = async () => {
  try {
    const port = Number(process.env.PORT) || 3000;
    await app.listen({ host: '0.0.0.0', port });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

export { app };

if (process.env.SKIP_SERVER_LISTEN !== '1') {
  await start();
}
