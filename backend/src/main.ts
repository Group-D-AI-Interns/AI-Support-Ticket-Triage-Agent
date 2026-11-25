import { loadEnvironment } from "./config/env.ts";
import { createLogger } from "./config/logger.ts";
import { createConfiguredServer } from "./server.ts";

const environment = loadEnvironment();
const logger = createLogger(environment.logLevel);
const server = await createConfiguredServer(environment);

server.listen(environment.port, environment.host, () => {
  logger.info("API server listening", {
    host: environment.host,
    port: environment.port,
    apiBasePath: "/api/v1",
    authMode: environment.authMode,
  });
});

function shutdown(signal: string) {
  logger.info("API server shutting down", { signal });
  server.close((error) => {
    if (error) {
      logger.error("API server shutdown failed", { errorType: error.name });
      process.exitCode = 1;
    }
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
