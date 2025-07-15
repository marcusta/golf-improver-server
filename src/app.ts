import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { createApiRoutes } from "./api/api";
import { createLoggingMiddleware } from "./api/hono-middlewares";
import { createServices } from "./services";
import { 
  UnauthorizedError, 
  NotFoundError, 
  ValidationError, 
  ConflictError, 
  ForbiddenError, 
  TemplateApplicationError,
  ComplianceViolationError,
  LockAcquisitionError,
  InsufficientPermissionsError,
  ExternalServiceError
} from "./services/errors";

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

  // --- Global Error Handling ---
  app.onError((err, c) => {
    console.error(`[API Error] Path: ${c.req.path}`, err);

    if (err instanceof HTTPException) {
      return err.getResponse();
    }
    
    // Handle custom service errors
    if (err instanceof UnauthorizedError) {
      return c.json({ error: err.message }, 401);
    }
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    if (err instanceof ValidationError || err instanceof TemplateApplicationError) {
      return c.json({ error: err.message }, 400);
    }
    if (err instanceof ConflictError || err instanceof LockAcquisitionError) {
      return c.json({ error: err.message }, 409);
    }
    if (err instanceof ForbiddenError || err instanceof InsufficientPermissionsError) {
      return c.json({ error: err.message }, 403);
    }
    if (err instanceof ComplianceViolationError) {
      return c.json({ error: err.message }, 422);
    }
    if (err instanceof ExternalServiceError) {
      return c.json({ error: err.message }, 503);
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
