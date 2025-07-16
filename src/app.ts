import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { createApiRoutes } from "./api/api";
import { createLoggingMiddleware } from "./api/hono-middlewares";
import { createServices } from "./services";
import { createMCPRoutes } from "./mcp/advanced-mcp-server-http";

/**
 * Creates the main Hono application.
 * @param database - Database instance to inject into services.
 * @returns The configured Hono app instance.
 */
export function createHonoApp(database: Database) {
  // 1. Create dependencies
  const services = createServices(database);

  // 2. Create Hono app
  const app = new Hono();

  // 3. Apply global middleware
  app.use("*", cors());
  app.use("*", createLoggingMiddleware(500)); // Log all requests and performance

  // 4. Mount API routes
  const apiRoutes = createApiRoutes(services);
  app.route("/rpc", apiRoutes);
  
  // 5. Mount MCP routes (async initialization will happen later)
  const mcpRoutes = createMCPRoutes(app, services);
  app.route("/mcp", mcpRoutes);

  // --- Global Error Handling ---
  app.onError((err, c) => {
    console.error(`[API Error] Path: ${c.req.path}`, err);

    // All our custom errors now extend HTTPException, so this handles them all
    if (err instanceof HTTPException) {
      return err.getResponse();
    }

    // Fallback for unexpected errors
    return c.json({ error: "Internal Server Error" }, 500);
  });

  // --- Simple status endpoint ---
  app.get("/", (c) => {
    return c.json({
      message: "Server is running. API available under /rpc",
    });
  });

  // --- Health check ---
  app.get("/health", (c) => {
    return c.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  return { app };
}
