import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { type Services } from "../services";
import {
  combineMiddleware,
  createAuthMiddleware,
  createErrorMiddleware,
  createPerformanceMiddleware,
  createRequestLoggingMiddleware,
  skipAuthFilter,
  wrapProcedures,
} from "./orpc-middlewares";
import { LoginUserSchema, RegisterUserSchema } from "./schemas/auth";
import { 
  CreateRoundSchema, 
  GetRoundSchema, 
  ListRoundsSchema 
} from "./schemas/rounds";
import { CreateTestTemplateSchema } from "./schemas/tests";

/**
 * Creates RPC procedures with injected services (clean, no middleware here)
 * @param services - Services container with all business logic
 * @returns Object containing all RPC procedures
 */
function createProcedures(services: Services) {
  return {
    // ========================================
    // Authentication procedures
    // ========================================
    auth: {
      register: os.input(RegisterUserSchema).handler(async ({ input }) => {
        return await services.auth.register(input);
      }),
      login: os.input(LoginUserSchema).handler(async ({ input }) => {
        return await services.auth.login(input);
      }),
    },

    // ========================================
    // Test Templates procedures
    // ========================================
    tests: {
      list: os.handler(async () => {
        return await services.testTemplates.listTests();
      }),
      create: os.input(CreateTestTemplateSchema).handler(async ({ input }) => {
        return await services.testTemplates.createTestTemplate(input);
      }),
    },

    // ========================================
    // Rounds procedures
    // ========================================
    rounds: {
      create: os.input(CreateRoundSchema).handler(async ({ input, context }) => {
        return await services.rounds.createRound(input, (context as any).user.id);
      }),
      list: os.input(ListRoundsSchema).handler(async ({ input, context }) => {
        return await services.rounds.listRounds(input, (context as any).user.id);
      }),
      get: os.input(GetRoundSchema).handler(async ({ input, context }) => {
        return await services.rounds.getRound(input, (context as any).user.id);
      }),
    },

    // ========================================
    // User Profile procedures
    // ========================================
    user: {
      profile: os.handler(async ({ context }) => {
        return await services.user.getProfile((context as any).user.id);
      }),
    },
  };
}

/**
 * Creates the oRPC handler and router from a services container.
 * All middleware is applied here in a clean, composable way.
 * @param services - The fully instantiated services container.
 * @returns An object containing the rpcHandler and router.
 */
export function createApp(services: Services) {
  // 1. Create clean procedures without any middleware
  const rawRouter = createProcedures(services);

  // 2. Create middleware stack
  const middleware = combineMiddleware(
    createErrorMiddleware(), // Always first - catches all errors
    createRequestLoggingMiddleware(), // Log all requests
    createPerformanceMiddleware(500), // Warn on operations > 500ms
  );

  // 3. Apply middleware to all procedures
  let router = wrapProcedures(rawRouter, middleware);

  // 4. Apply auth middleware (with filter to skip auth endpoints)
  router = wrapProcedures(router, createAuthMiddleware(), skipAuthFilter);

  // 5. Create RPC handler
  const rpcHandler = new RPCHandler(router);

  return { rpcHandler, router };
}
