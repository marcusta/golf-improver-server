export class AuthError extends Error {
  constructor(
    public code: string,
    public message: string,
    public details?: Record<string, string>
  ) {
    super(message);
    this.name = "AuthError";
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      ...(this.details && { details: this.details })
    };
  }
}

export class InvalidCredentialsError extends AuthError {
  constructor(message: string = "Invalid email or password") {
    super("invalid_credentials", message);
  }
}

export class InvalidTokenError extends AuthError {
  constructor(message: string = "Access token is invalid or expired") {
    super("invalid_token", message);
  }
}

export class InvalidRefreshTokenError extends AuthError {
  constructor(message: string = "Refresh token is invalid or expired") {
    super("invalid_refresh_token", message);
  }
}

export class TokenExpiredError extends AuthError {
  constructor(message: string = "Access token has expired") {
    super("token_expired", message);
  }
}

export class AccountLockedError extends AuthError {
  constructor(message: string = "Account is temporarily locked") {
    super("account_locked", message);
  }
}

export class RegistrationFailedError extends AuthError {
  constructor(message: string = "Registration validation failed", details?: Record<string, string>) {
    super("registration_failed", message, details);
  }
}