import { HTTPException } from "hono/http-exception";

export class NotFoundError extends HTTPException {
  constructor(message: string) {
    super(404, { message });
  }
}

export class UnauthorizedError extends HTTPException {
  constructor(message: string) {
    super(401, { message });
  }
}

export class ConflictError<T> extends HTTPException {
  public data: T;
  constructor(message: string, freshData: T) {
    super(409, { message });
    this.data = freshData;
  }
}

export class ForbiddenError extends HTTPException {
  constructor(message: string) {
    super(403, { message });
  }
}

export class TemplateApplicationError extends HTTPException {
  constructor(message: string, templateId?: string) {
    const fullMessage = templateId
      ? `${message} (Template: ${templateId})`
      : message;
    super(400, { message: fullMessage });
  }
}

export class ComplianceViolationError extends HTTPException {
  constructor(message: string, violationCount?: number) {
    const fullMessage = violationCount
      ? `${message} (${violationCount} violations found)`
      : message;
    super(422, { message: fullMessage });
  }
}

export class LockAcquisitionError extends ConflictError<unknown> {
  constructor(message: string, existingLock: unknown) {
    super(message, existingLock);
  }
}

export class InsufficientPermissionsError extends HTTPException {
  constructor(message: string, requiredRole?: string, userRole?: string) {
    const roleInfo = requiredRole
      ? ` (Required: ${requiredRole}, Current: ${userRole || "none"})`
      : "";
    super(403, { message: `${message}${roleInfo}` });
  }
}

export class ValidationError extends HTTPException {
  constructor(message: string, field?: string) {
    const fullMessage = field ? `${message} (Field: ${field})` : message;
    super(400, { message: fullMessage });
  }
}

export class ExternalServiceError extends HTTPException {
  constructor(message: string, service?: string) {
    const fullMessage = service ? `${message} (Service: ${service})` : message;
    super(503, { message: fullMessage });
  }
}
