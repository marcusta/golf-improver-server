Server API Specification for Token Management

  Required Server API Changes

  # 1. Enhanced Authentication Endpoints

  POST /rpc/auth/login (MODIFY EXISTING)
  // Request (no changes)
  {
    "email": "user@example.com",
    "password": "password123"
  }

  // Response (ENHANCED)
  {
    "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expires_in": 3600,
    "token_type": "Bearer",
    "user": {
      "id": "user_uuid",
      "email": "user@example.com",
      "first_name": "John",
      "last_name": "Doe"
    }
  }

  POST /rpc/auth/register (MODIFY EXISTING)
  // Request (no changes)
  {
    "email": "user@example.com",
    "password": "password123",
    "first_name": "John",
    "last_name": "Doe"
  }

  // Response (ENHANCED - same as login)
  {
    "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expires_in": 3600,
    "token_type": "Bearer",
    "user": {
      "id": "user_uuid",
      "email": "user@example.com",
      "first_name": "John",
      "last_name": "Doe"
    }
  }

  # 2. New Token Management Endpoints

  POST /rpc/auth/refresh (NEW)
  // Request
  {
    "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }

  // Response
  {
    "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expires_in": 3600,
    "token_type": "Bearer"
  }

  // Error Response (401)
  {
    "error": "invalid_refresh_token",
    "message": "Refresh token is invalid or expired"
  }

  POST /rpc/auth/logout (NEW)
  // Request
  {
    "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }

  // Response
  {
    "message": "Successfully logged out"
  }

  // Error Response (401)
  {
    "error": "invalid_token",
    "message": "Token is invalid or already expired"
  }

  3. Enhanced Error Handling

  Standard Error Response Format:
  {
    "error": "error_code",
    "message": "Human readable error message",
    "details": {
      "field": "Specific field error if applicable"
    }
  }

  ## Error Codes for Authentication:
  - invalid_credentials - Wrong email/password
  - invalid_token - Access token invalid/expired
  - invalid_refresh_token - Refresh token invalid/expired
  - token_expired - Access token expired (client should refresh)
  - account_locked - Account temporarily locked
  - registration_failed - Registration validation failed

  # 4. Token Requirements

  Access Token:
  - Expiration: 1 hour (3600 seconds)
  - Claims: user_id, email, exp, iat, iss
  - Algorithm: HS256 or RS256

  Refresh Token:
  - Expiration: 30 days (2592000 seconds)
  - Claims: user_id, exp, iat, iss, type: "refresh"
  - Algorithm: HS256 or RS256
  - Storage: Server-side blacklist for revoked tokens

  # 5. Database Schema Requirements

  Refresh Token Storage:
  CREATE TABLE refresh_tokens (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id),
      token_hash VARCHAR(255) NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      revoked_at TIMESTAMP NULL,
      INDEX idx_user_id (user_id),
      INDEX idx_token_hash (token_hash),
      INDEX idx_expires_at (expires_at)
  );

  # Implementation Notes

  1. Token Rotation: Each refresh generates new access + refresh tokens
  2. Security: Store hashed refresh tokens in database
  3. Cleanup: Regular cleanup of expired refresh tokens
  4. Rate Limiting: Implement rate limiting on auth endpoints
  5. Logging: Log all authentication events for security monitoring