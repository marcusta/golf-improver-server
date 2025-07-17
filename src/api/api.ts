import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { type Services } from "../services";
import { authMiddleware } from "./hono-middlewares";
import { type AppContext } from "./types";

// Import your Zod schemas
import { LoginUserSchema, RegisterUserSchema, RefreshTokenSchema } from "./schemas/auth";
import {
  CreateRoundSchema,
  GetRoundSchema,
  ListRoundsSchema,
} from "./schemas/rounds";
import { CreateTestTemplateSchema } from "./schemas/tests";

/**
 * Creates all the Hono API routes.
 * @param services - The fully instantiated services container.
 * @returns A Hono instance containing all API routes.
 */
export function createApiRoutes(services: Services) {
  // Use the AppContext generic to get typed context for `c.get('user')`
  const app = new Hono<AppContext>();

  // ========================================
  // Public Routes (No Auth)
  // ========================================
  app.post(
    "/auth/register",
    zValidator("json", RegisterUserSchema),
    async (c) => {
      const input = c.req.valid("json");
      const result = await services.auth.register(input);
      return c.json(result);
    }
  );

  app.post("/auth/login", zValidator("json", LoginUserSchema), async (c) => {
    const input = c.req.valid("json");
    const result = await services.auth.login(input);
    return c.json(result);
  });

  app.post("/auth/refresh", zValidator("json", RefreshTokenSchema), async (c) => {
    const input = c.req.valid("json");
    const result = await services.auth.refreshToken(input);
    return c.json(result);
  });

  app.post("/auth/logout", zValidator("json", RefreshTokenSchema), async (c) => {
    const input = c.req.valid("json");
    const result = await services.auth.logout(input);
    return c.json(result);
  });

  // You mentioned tests.list and tests.create were public in your filter
  app.post("/tests/list", async (c) => {
    const tests = await services.testTemplates.listTests();
    return c.json(tests);
  });

  app.post(
    "/tests/create",
    zValidator("json", CreateTestTemplateSchema),
    async (c) => {
      const input = c.req.valid("json");
      const result = await services.testTemplates.createTestTemplate(input);
      return c.json(result);
    }
  );

  // A simple public ping endpoint
  app.post("/ping", (c) => c.json("pong"));

  // ========================================
  // Protected Routes (Auth Required)
  // ========================================
  const protectedRoutes = new Hono<AppContext>();
  protectedRoutes.use("*", authMiddleware);

  // --- Rounds ---
  protectedRoutes.post(
    "/rounds/create",
    zValidator("json", CreateRoundSchema),
    async (c) => {
      const input = c.req.valid("json");
      const user = c.get("user");
      const result = await services.rounds.createRound(input, user.id);
      return c.json(result);
    }
  );

  protectedRoutes.post(
    "/rounds/list",
    zValidator("json", ListRoundsSchema),
    async (c) => {
      const input = c.req.valid("json");
      const user = c.get("user");
      const result = await services.rounds.listRounds(input, user.id);
      return c.json(result);
    }
  );

  protectedRoutes.post(
    "/rounds/get",
    zValidator("json", GetRoundSchema),
    async (c) => {
      const input = c.req.valid("json");
      const user = c.get("user");
      const result = await services.rounds.getRound(input, user.id);
      return c.json(result);
    }
  );

  // --- User Profile ---
  protectedRoutes.post("/user/profile", async (c) => {
    const user = c.get("user");
    const profile = await services.user.getProfile(user.id);
    return c.json(profile);
  });

  // Mount the protected routes under the main app
  app.route("/", protectedRoutes);

  return app;
}
