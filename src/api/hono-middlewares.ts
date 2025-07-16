import { type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { verify } from "hono/jwt";
import { type UserPayload } from "./types";

/**
 * Middleware to log requests and measure performance.
 */
export function createLoggingMiddleware(
  slowThresholdMs: number = 500
): MiddlewareHandler {
  return async (c, next) => {
    const start = Date.now();
    await next();
    const duration = Date.now() - start;
    // also log the request body if it's a POST request
    if (c.req.method === "POST") {
      console.log(
        `[API Request] ${c.req.method} ${c.req.path} | Status: ${c.res.status} | Duration: ${duration}ms | Body: ${JSON.stringify(c.req.raw.body)}`
      );
    } else {
      console.log(
        `[API Request] ${c.req.method} ${c.req.path} | Status: ${c.res.status} | Duration: ${duration}ms`
      );
    }

    if (duration > slowThresholdMs) {
      console.warn(
        `[API Slow] ${c.req.method} ${c.req.path} took ${duration}ms (Threshold: ${slowThresholdMs}ms)`
      );
    }
  };
}

/**
 * Middleware to handle authentication.
 * It verifies the JWT and adds the user payload to the context.
 */
export const authMiddleware: MiddlewareHandler<{
  Variables: { user: UserPayload };
}> = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  const jwtSecret = process.env["JWT_SECRET"];

  if (!authHeader?.startsWith("Bearer ") || !jwtSecret) {
    throw new HTTPException(401, { message: "Authentication required" });
  }

  const token = authHeader.slice(7);
  try {
    const payload = await verify(token, jwtSecret);
    if (!payload || typeof payload["userId"] !== "string") {
      throw new Error("Invalid payload");
    }
    // Add the user payload to the context for downstream handlers
    c.set("user", { id: payload["userId"] as string });
  } catch (error) {
    console.error("Error verifying token:", error);
    throw new HTTPException(401, { message: "Invalid or expired token" });
  }

  await next();
};
