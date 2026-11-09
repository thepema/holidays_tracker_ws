import Fastify from 'fastify';
import cors from '@fastify/cors';

const app = Fastify({
  logger: true,
});

await app.register(cors, {
  // Allow the development frontend; override with CORS_ORIGIN per environment if needed.
  origin: process.env.CORS_ORIGIN || 'https://holiday-tracker.dev.maisonzaro.com',
});

app.get('/', async () => ({
  message: '¡Hola, mundo!',
}));

const start = async () => {
  try {
    const port = Number(process.env.PORT) || 3000;
    await app.listen({ host: '0.0.0.0', port });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

await start();
