import { loadServerConfig } from './config.js';
import { createApp } from './app.js';

try {
  process.loadEnvFile();
} catch {
  // no .env file; rely on the environment
}

const config = loadServerConfig();
const app = createApp(config);
const port = await app.listen();

console.log(`[server] MCP endpoint:      http://localhost:${port}/mcp`);
console.log(`[server] Demo order trigger: POST http://localhost:${port}/demo/orders  (or: npm run order)`);
console.log(`[server] Outpost API:        ${config.outpost.baseUrl}`);
console.log(`[server] Principals:         ${[...new Set(config.tokens.values())].join(', ')}`);
if (config.allowLocalCallbacks) {
  console.warn('[server] ALLOW_LOCAL_CALLBACKS=true: http and private callback addresses are allowed. Dev only.');
}

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
