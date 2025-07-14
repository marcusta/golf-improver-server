import { UnauthorizedError } from "../services/errors";

// ========================================
// Generic and Type-Safe Core Types
// ========================================

/**
 * A generic type representing any procedure handler function.
 * This is the base for our generic operations.
 */
export type AnyProcedureHandler = (...args: any[]) => any;

/**
 * A generic middleware function that preserves the type of the handler it wraps.
 * It takes a handler of a specific type `T` and must return a handler of that same type `T`.
 */
export type MiddlewareFunction = <T extends AnyProcedureHandler>(
  handler: T,
  procedurePath: string
) => T;

/**
 * A type representing the nested object structure of a procedure router.
 * Using a generic record allows us to handle arbitrary nesting.
 */
type ProcedureStructure = { [key: string]: unknown };

/**
 * A filter function to conditionally apply middleware.
 * This type does not need to be generic as it only reads properties, not transforms them.
 */
export type FilterFunction = (
  procedurePath: string,
  procedure: unknown
) => boolean;

// ========================================
// Type Guards and Helper Types
// ========================================

/**
 * Describes the structure of the first argument passed to many procedures,
 * which often contains input data and context.
 */
type ProcedureArgument = {
  input?: unknown;
  context?: {
    user?: { id?: string };
    invalidToken?: boolean;
  };
};

/**
 * Type guard to check if an argument is a valid, object-like procedure payload.
 * @param arg The value to check.
 * @returns {boolean} True if the value is a non-null object that could be a payload.
 */
function isProcedureArgument(arg: unknown): arg is ProcedureArgument {
  // This guard confirms the argument is an object, allowing safe access to its properties.
  return arg !== null && typeof arg === "object";
}

/**
 * Describes the expected structure of a procedure object within the router.
 */
type ProcedureWithHandler = {
  handler: AnyProcedureHandler;
  [key: string]: unknown; // Allows for other properties like 'meta'
};

/**
 * Type guard to check if a value is a procedure object with a handler function.
 * @param value The value to check.
 * @returns {boolean} True if the value is a valid procedure object.
 */
function isProcedureWithHandler(value: unknown): value is ProcedureWithHandler {
  return (
    value !== null &&
    typeof value === "object" &&
    "handler" in value &&
    typeof (value as { handler: unknown }).handler === "function"
  );
}

/**
 * Type guard to check if a value is a plain object suitable for recursion.
 * @param value The value to check.
 * @returns {boolean} True if the value is a non-null, non-array object.
 */
function isPlainObject(value: unknown): value is { [key: string]: unknown } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ========================================
// Core Wrapper Function
// ========================================

/**
 * Recursively wraps procedures with middleware, preserving the original object shape and types.
 * @template T The type of the procedures object.
 * @param {T} procedures The procedures object to wrap.
 * @param {MiddlewareFunction} middleware The middleware to apply.
 * @param {FilterFunction} [filter] A function to conditionally skip wrapping.
 * @returns {T} A new object with the same shape and types as the input, with handlers wrapped.
 */
export function wrapProcedures<T extends ProcedureStructure>(
  procedures: T,
  middleware: MiddlewareFunction,
  filter?: FilterFunction,
  basePath: string = "",
  depth: number = 0
): T {
  // Prevent infinite recursion
  if (depth > 20) {
    console.warn(`[Procedure Wrapper] Max depth reached at ${basePath}`);
    return procedures;
  }

  // The `isPlainObject` guard also handles the null/undefined/array cases for us.
  if (!isPlainObject(procedures)) {
    return procedures;
  }

  const wrapped: ProcedureStructure = {};

  for (const key in procedures) {
    if (Object.prototype.hasOwnProperty.call(procedures, key)) {
      const value = procedures[key];
      const currentPath = basePath ? `${basePath}.${key}` : key;

      // Use the isPlainObject guard to identify traversable objects.
      if (isPlainObject(value)) {
        // Within this block, check if it's a specific procedure or just a nested group.
        if (isProcedureWithHandler(value)) {
          const shouldWrap = !filter || filter(currentPath, value);

          if (shouldWrap) {
            wrapped[key] = {
              ...value,
              handler: middleware(value.handler, currentPath),
            };
          } else {
            wrapped[key] = value;
          }
        } else {
          // It's a nested object, so we recurse. The type of `value` is now
          // correctly inferred as `{ [key: string]: unknown }`, which satisfies the function's constraint.
          wrapped[key] = wrapProcedures(
            value,
            middleware,
            filter,
            currentPath,
            depth + 1
          );
        }
      } else {
        // This is a primitive value, so we copy it as-is.
        wrapped[key] = value;
      }
    }
  }

  return wrapped as T;
}

/**
 * Combines multiple middleware functions into a single one, executed from right to left.
 * This function is also generic and preserves the handler's type signature.
 */
export function combineMiddleware(
  ...middlewares: MiddlewareFunction[]
): MiddlewareFunction {
  return <T extends AnyProcedureHandler>(
    handler: T,
    procedurePath: string
  ): T => {
    return middlewares.reduceRight(
      (wrappedHandler, mw) => mw(wrappedHandler, procedurePath),
      handler
    );
  };
}

// ========================================
// Middleware Implementation Functions
// ========================================

/**
 * Error logging and handling middleware.
 */
export function createErrorMiddleware(): MiddlewareFunction {
  return <T extends AnyProcedureHandler>(
    handler: T,
    procedurePath: string
  ): T => {
    const wrappedHandler = async (
      ...args: Parameters<T>
    ): Promise<ReturnType<T>> => {
      try {
        return await handler(...args);
      } catch (error) {
        // Use the type guard to safely access the input property
        const firstArg = args[0];
        const input = isProcedureArgument(firstArg)
          ? firstArg.input
          : undefined;
        console.error(`[RPC Error] ${procedurePath}:`, {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          input,
          timestamp: new Date().toISOString(),
        });
        throw error;
      }
    };
    return wrappedHandler as T;
  };
}

/**
 * Context-based authentication middleware.
 */
export function createAuthMiddleware(): MiddlewareFunction {
  return <T extends AnyProcedureHandler>(
    handler: T,
    procedurePath: string
  ): T => {
    const wrappedHandler = async (
      ...args: Parameters<T>
    ): Promise<ReturnType<T>> => {
      const cleanPath = procedurePath.replace(".~orpc", "");

      if (cleanPath === "auth.login" || cleanPath === "auth.register") {
        return handler(...args);
      }

      const firstArg = args[0];
      const context = isProcedureArgument(firstArg)
        ? firstArg.context
        : undefined;

      if (context?.invalidToken) {
        console.log(`[Auth Middleware] Invalid token for ${cleanPath}`);
        throw new UnauthorizedError("Invalid token");
      }

      // The optional chaining `?.` safely handles cases where context or user is undefined.
      if (!context?.user?.id) {
        console.log(`[Auth Middleware] Missing user context for ${cleanPath}`);
        throw new UnauthorizedError("Authentication required");
      }

      console.log(
        `[Auth Middleware] Auth passed for ${cleanPath}, user: ${context.user.id}`
      );
      return handler(...args);
    };
    return wrappedHandler as T;
  };
}

/**
 * Request logging middleware.
 */
export function createRequestLoggingMiddleware(): MiddlewareFunction {
  return <T extends AnyProcedureHandler>(
    handler: T,
    procedurePath: string
  ): T => {
    const wrappedHandler = async (
      ...args: Parameters<T>
    ): Promise<ReturnType<T>> => {
      const firstArg = args[0];
      const payload = isProcedureArgument(firstArg) ? firstArg : undefined;
      const input = payload?.input;
      const userId = payload?.context?.user?.id;

      console.log(`[RPC Request] ${procedurePath}:`, {
        userId,
        input,
        timestamp: new Date().toISOString(),
      });

      const startTime = Date.now();
      try {
        const result = await handler(...args);
        console.log(
          `[RPC Success] ${procedurePath}: ${Date.now() - startTime}ms`
        );
        return result;
      } catch (error) {
        console.log(
          `[RPC Failed] ${procedurePath}: ${Date.now() - startTime}ms`
        );
        throw error;
      }
    };
    return wrappedHandler as T;
  };
}

/**
 * Performance monitoring middleware.
 */
export function createPerformanceMiddleware(
  slowThresholdMs: number = 1000
): MiddlewareFunction {
  return <T extends AnyProcedureHandler>(
    handler: T,
    procedurePath: string
  ): T => {
    const wrappedHandler = async (
      ...args: Parameters<T>
    ): Promise<ReturnType<T>> => {
      const startTime = Date.now();
      try {
        const result = await handler(...args);
        const duration = Date.now() - startTime;
        if (duration > slowThresholdMs) {
          console.warn(
            `[RPC Slow] ${procedurePath}: ${duration}ms (threshold: ${slowThresholdMs}ms)`
          );
        }
        return result;
      } catch (error) {
        console.log(
          `[RPC Failed] ${procedurePath}: ${Date.now() - startTime}ms`
        );
        throw error;
      }
    };
    return wrappedHandler as T;
  };
}

/**
 * A simple debug middleware to verify wrapping.
 */
export function createDebugMiddleware(): MiddlewareFunction {
  return <T extends AnyProcedureHandler>(
    handler: T,
    procedurePath: string
  ): T => {
    console.log(`[Debug Middleware] Creating wrapper for ${procedurePath}`);
    const wrappedHandler = async (
      ...args: Parameters<T>
    ): Promise<ReturnType<T>> => {
      console.log(`[Debug Middleware] EXECUTING FOR ${procedurePath}!!!`);
      const result = await handler(...args);
      console.log(`[Debug Middleware] Handler completed for ${procedurePath}`);
      return result;
    };
    return wrappedHandler as T;
  };
}

// ========================================
// Filter Function Implementations
// ========================================

/**
 * Skip authentication for specific procedures.
 */
export const skipAuthFilter: FilterFunction = (procedurePath) => {
  const cleanPath = procedurePath.replace(".~orpc", "");
  const shouldSkip = ["ping", "auth.login", "auth.register", "tests.list", "tests.create"].includes(cleanPath);
  return !shouldSkip;
};

/**
 * Skip audit logging for audit procedures to prevent recursion.
 */
export const skipAuditFilter: FilterFunction = (procedurePath) => {
  const cleanPath = procedurePath.replace(".~orpc", "");
  return !cleanPath.startsWith("audit.");
};

/**
 * Only apply to procedures that appear to be mutations.
 */
export const mutationOnlyFilter: FilterFunction = (procedurePath) => {
  return /\.(create|update|delete|add|remove)/.test(procedurePath);
};

/**
 * Creates a filter to exclude specific procedures by path.
 */
export const excludeFilter = (excludedPaths: string[]): FilterFunction => {
  return (procedurePath) => {
    return !excludedPaths.some(
      (excluded) =>
        procedurePath === excluded || procedurePath.startsWith(excluded + ".")
    );
  };
};

/**
 * Creates a filter to include only specific procedures by path.
 */
export const includeFilter = (includedPaths: string[]): FilterFunction => {
  return (procedurePath) => {
    return includedPaths.some(
      (included) =>
        procedurePath === included || procedurePath.startsWith(included + ".")
    );
  };
};

/**
 * Creates a filter based on regular expression patterns.
 */
export const patternFilter = (patterns: RegExp[]): FilterFunction => {
  return (procedurePath) => {
    return patterns.some((pattern) => pattern.test(procedurePath));
  };
};
