import { Database } from "bun:sqlite";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { verify } from "hono/jwt";
import { createApp } from "./api/orpc-api";
import { createServices } from "./services";

/**
 * Creates a Hono application instance with minimal middleware
 * Only handles JWT parsing and passes context to oRPC
 * @param database - Database instance to inject into services
 * @returns Configured Hono app instance
 */
export function createHonoApp(database: Database) {
  // 1. Create dependencies
  const services = createServices(database);

  // 2. Create oRPC app with all middleware built-in
  const { rpcHandler, router } = createApp(services);

  const app = new Hono();

  // --- Global Error Handling ---
  app.onError((err, c) => {
    const timestamp = new Date().toISOString();
    const errorInfo = {
      timestamp,
      path: c.req.path,
      method: c.req.method,
      userAgent: c.req.header("User-Agent"),
      error: err.message,
      stack: err.stack
    };
    console.error(`[${timestamp}] [ERROR] CRITICAL_HONO_ERROR:`, JSON.stringify(errorInfo, null, 2));
    return c.json({ error: "Internal Server Error" }, 500);
  });

  // --- CORS ---
  app.use("/rpc/*", cors());

  // --- Minimal JWT Parsing & oRPC Handler ---
  app.use("/rpc/*", async (c: Context, next) => {
    const url = new URL(c.req.url);
    const action = url.pathname.replace("/rpc/", "");
    let context: any = {};

    // Only parse JWT, don't validate - let oRPC middleware handle validation
    if (action !== "auth/login" && action !== "auth/register") {
      const authHeader = c.req.header("Authorization");
      const jwtSecret = process.env["JWT_SECRET"];

      if (authHeader?.startsWith("Bearer ") && jwtSecret) {
        const token = authHeader.slice(7);
        try {
          const payload = await verify(token, jwtSecret);
          context = { user: { id: payload["userId"] as string } };
        } catch (error) {
          // Mark that token was provided but invalid
          context = { invalidToken: true };
        }
      }
      // If no Authorization header, context remains empty object (no token provided)
    }

    try {
      const { matched, response } = await rpcHandler.handle(c.req.raw, {
        prefix: "/rpc",
        context,
      });
      if (matched) {
        return c.newResponse(response.body, response);
      }
      return await next();
    } catch (error) {
      const timestamp = new Date().toISOString();
      const errorInfo = {
        timestamp,
        path: c.req.path,
        method: c.req.method,
        userAgent: c.req.header("User-Agent"),
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      };
      console.error(`[${timestamp}] [ERROR] RPC_HANDLER_ERROR:`, JSON.stringify(errorInfo, null, 2));
      return c.json({ error: "Internal Server Error" }, 500);
    }
  });

  // --- Simple status endpoint ---
  app.get("/", (c) => {
    return c.json({
      message: "Server is running. oRPC endpoint available at /rpc",
      procedures: Object.keys(router),
    });
  });

  // --- Health check ---
  app.get("/health", (c) => {
    return c.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  return { app, router };
}
