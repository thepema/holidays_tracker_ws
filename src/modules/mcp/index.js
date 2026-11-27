import mcpOAuthRoutes from './mcp-oauth.routes.js';
import mcpVacationsPlugin from './mcp.plugin.js';

export default async function mcpModule(app) {
  await app.register(mcpOAuthRoutes);
  await app.register(mcpVacationsPlugin);
}
