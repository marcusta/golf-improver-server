import { serve } from "bun";
import { Database } from "bun:sqlite";
import "dotenv/config";
import { createHonoApp } from "./app";
import { createServices } from "./services";

// Create production database

const dbFileName = process.env["DB_FILE_NAME"];
if (!dbFileName) {
  throw new Error("DB_FILE_NAME environment variable is not set");
}
const database = new Database(dbFileName);
console.log("Using database", dbFileName);
console.log("Database created", database);
// Create services and run seeding
const services = createServices(database);
await services.seed.seedDatabase();

// Create the Hono app with all middleware configured
const { app, router } = createHonoApp(database);
console.log("Router", router);
// --- Start Server ---
const port = 3100;
console.log(`🚀 Hono server is running on http://localhost:${port}`);
console.log(`📡 oRPC endpoint is available at /rpc`);

serve({
  fetch: app.fetch,
  port,
});

// Export the type for client-side type safety (note: this would need the router type from createApp)
// export type App = typeof router;

export const rpcRouter = router;
export type App = typeof router;
