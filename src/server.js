import Fastify from 'fastify';

const app = Fastify({
  logger: true,
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
