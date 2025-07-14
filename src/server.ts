import { serve } from "bun";
import { Database } from "bun:sqlite";
import "dotenv/config";
import { createHonoApp } from "./app";
import { createServices } from "./services";

// Enhanced logging for production
const isProduction = process.env.NODE_ENV === "production";
const logLevel = process.env.LOG_LEVEL || (isProduction ? "info" : "debug");

function log(level: string, message: string, ...args: any[]) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  
  if (level === "error") {
    console.error(logMessage, ...args);
  } else {
    console.log(logMessage, ...args);
  }
}

// Global error handlers
process.on('uncaughtException', (error) => {
  log('error', 'Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  log('error', 'Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Create production database

const dbFileName = process.env["DB_FILE_NAME"];
if (!dbFileName) {
  throw new Error("DB_FILE_NAME environment variable is not set");
}

log("info", "Starting Golf Improver Server");
log("info", `Environment: ${process.env.NODE_ENV || 'development'}`);
log("info", `Log Level: ${logLevel}`);

const database = new Database(dbFileName);
log("info", `Using database: ${dbFileName}`);

// Create services and run seeding
const services = createServices(database);
log("info", "Starting database seeding...");
await services.seed.seedDatabase();
log("info", "Database seeding completed");

// Create the Hono app with all middleware configured
const { app, router } = createHonoApp(database);
log("debug", `Available procedures: ${Object.keys(router).join(", ")}`);

// --- Start Server ---
const port = process.env.PORT ? parseInt(process.env.PORT) : 3100;
log("info", `🚀 Server starting on port ${port}`);
log("info", `📡 oRPC endpoint available at /rpc`);

serve({
  fetch: app.fetch,
  port,
});

// Export the type for client-side type safety (note: this would need the router type from createApp)
// export type App = typeof router;

export const rpcRouter = router;
export type App = typeof router;
