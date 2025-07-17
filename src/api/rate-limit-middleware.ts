import { type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

interface RateLimitStore {
  [key: string]: {
    count: number;
    resetTime: number;
  };
}

const store: RateLimitStore = {};

export function createRateLimitMiddleware(
  windowMs: number = 15 * 60 * 1000, // 15 minutes
  maxAttempts: number = 5
): MiddlewareHandler {
  return async (c, next) => {
    const clientIP =
      c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown";
    const key = `${clientIP}:${c.req.path}`;
    const now = Date.now();

    // Clean up expired entries
    if (store[key] && now > store[key].resetTime) {
      delete store[key];
    }

    // Initialize or increment counter
    if (!store[key]) {
      store[key] = { count: 1, resetTime: now + windowMs };
    } else {
      store[key].count++;
    }

    // Check if limit exceeded
    if (store[key].count > maxAttempts) {
      const resetIn = Math.ceil((store[key].resetTime - now) / 1000);
      throw new HTTPException(429, {
        message: `Too many attempts. Try again in ${resetIn} seconds.`,
      });
    }

    await next();
  };
}
