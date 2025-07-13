import { ORPCError } from "@orpc/server";

// We now extend ORPCError and provide a standard error code in the constructor,
// along with the expected type for any additional data.

export class NotFoundError extends ORPCError<"NOT_FOUND", unknown> {
  constructor(message: string) {
    // Use the standard 'NOT_FOUND' code recognized by oRPC.
    // The second generic argument is `unknown` as this error carries no extra data.
    super("NOT_FOUND", { message });
  }
}

export class UnauthorizedError extends ORPCError<"UNAUTHORIZED", unknown> {
  constructor(message: string) {
    // Use the standard 'UNAUTHORIZED' code recognized by oRPC.
    super("UNAUTHORIZED", { message });
  }
}

export class ConflictError<T> extends ORPCError<"CONFLICT", T> {
  // The 'data' property on ORPCError is perfect for sending back the fresh data.
  constructor(message: string, freshData: T) {
    // Use the standard 'CONFLICT' code and pass the generic type T for the data.
    super("CONFLICT", {
      message,
      data: freshData,
    });
  }
}

export class ForbiddenError extends ORPCError<"FORBIDDEN", unknown> {
  constructor(message: string) {
    // Use the standard 'FORBIDDEN' code recognized by oRPC.
    super("FORBIDDEN", { message });
  }
}

export class TemplateApplicationError extends ORPCError<
  "BAD_REQUEST",
  unknown
> {
  constructor(message: string, templateId?: string) {
    const fullMessage = templateId
      ? `${message} (Template: ${templateId})`
      : message;
    super("BAD_REQUEST", { message: fullMessage });
  }
}

export class ComplianceViolationError extends ORPCError<
  "UNPROCESSABLE_ACTOR",
  unknown
> {
  constructor(message: string, violationCount?: number) {
    const fullMessage = violationCount
      ? `${message} (${violationCount} violations found)`
      : message;
    super("UNPROCESSABLE_ACTOR", { message: fullMessage });
  }
}

export class LockAcquisitionError extends ConflictError<any> {
  constructor(message: string, existingLock: any) {
    super(message, existingLock);
  }
}

export class InsufficientPermissionsError extends ORPCError<
  "FORBIDDEN",
  unknown
> {
  constructor(message: string, requiredRole?: string, userRole?: string) {
    const roleInfo = requiredRole
      ? ` (Required: ${requiredRole}, Current: ${userRole || "none"})`
      : "";
    super("FORBIDDEN", { message: `${message}${roleInfo}` });
  }
}

export class ValidationError extends ORPCError<"BAD_REQUEST", unknown> {
  constructor(message: string, field?: string) {
    const fullMessage = field ? `${message} (Field: ${field})` : message;
    super("BAD_REQUEST", { message: fullMessage });
  }
}

export class ExternalServiceError extends ORPCError<
  "SERVICE_UNAVAILABLE",
  unknown
> {
  constructor(message: string, service?: string) {
    const fullMessage = service ? `${message} (Service: ${service})` : message;
    super("SERVICE_UNAVAILABLE", { message: fullMessage });
  }
}
