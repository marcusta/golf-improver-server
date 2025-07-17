import type { Database } from "bun:sqlite";
import "dotenv/config";
import { eq, and, isNull, gte } from "drizzle-orm";
import { sign, verify } from "hono/jwt";
import { createHash, randomBytes } from "node:crypto";
import type { LoginUserType, RegisterUserType, RefreshTokenType } from "../api/schemas/auth";
import { getDb } from "../db";
import * as schema from "../db/schema";
import { NotFoundError } from "./errors";
import { InvalidCredentialsError, InvalidRefreshTokenError, RegistrationFailedError } from "../api/auth-errors";

export class AuthService {
  private db: ReturnType<typeof getDb>;

  constructor(database: Database) {
    this.db = getDb(database);
  }

  private async generateTokens(userId: string): Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
  }> {
    const jwtSecret = process.env["JWT_SECRET"];
    if (!jwtSecret) {
      throw new Error("JWT_SECRET environment variable is not set");
    }

    // Generate access token (1 hour)
    const accessTokenExp = Math.floor(Date.now() / 1000) + (60 * 60);
    const accessToken = await sign({
      userId,
      exp: accessTokenExp
    }, jwtSecret);

    // Generate refresh token (30 days)
    const refreshTokenPayload = randomBytes(32).toString('hex');
    const refreshTokenExp = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60);
    const refreshToken = await sign({
      userId,
      payload: refreshTokenPayload,
      type: "refresh",
      exp: refreshTokenExp,
      iat: Math.floor(Date.now() / 1000)
    }, jwtSecret);

    // Store refresh token hash in database
    const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
    await this.db.insert(schema.refreshTokens).values({
      userId,
      tokenHash,
      expiresAt: new Date(refreshTokenExp * 1000)
    });

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600,
      token_type: "Bearer"
    };
  }

  async register(input: RegisterUserType) {
    try {
      const existingUser = await this.db.query.users.findFirst({
        where: eq(schema.users.email, input.email),
      });

      if (existingUser) {
        // Use generic error to prevent email enumeration during registration
        throw new RegistrationFailedError("Registration failed. Please try again with different details.");
      }

      const passwordHash = await Bun.password.hash(input.password);

      const newUser = await this.db
        .insert(schema.users)
        .values({
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
          passwordHash,
        })
        .returning();

      const tokens = await this.generateTokens(newUser[0]!.id);

      return {
        ...tokens,
        user: {
          id: newUser[0]!.id,
          email: newUser[0]!.email,
          first_name: newUser[0]!.firstName,
          last_name: newUser[0]!.lastName,
        },
      };
    } catch (error) {
      console.error("Error registering user:", error);
      throw error;
    }
  }

  async login(input: LoginUserType) {
    // Always perform password hashing to prevent timing attacks
    // This ensures consistent response time regardless of whether user exists
    const dummyPassword = "dummy-password-for-timing-protection";
    
    const user = await this.db.query.users.findFirst({
      where: eq(schema.users.email, input.email),
    });

    // Perform password verification whether user exists or not
    const passwordToVerify = user?.passwordHash || await Bun.password.hash(dummyPassword);
    const isValidPassword = await Bun.password.verify(input.password, passwordToVerify);

    // Only proceed if both user exists AND password is valid
    if (!user || !isValidPassword) {
      // Use generic error message to prevent email enumeration
      throw new InvalidCredentialsError("Invalid email or password");
    }

    await this.db
      .update(schema.users)
      .set({ lastLoginAt: new Date() })
      .where(eq(schema.users.id, user.id));

    const tokens = await this.generateTokens(user.id);

    return {
      ...tokens,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.firstName,
        last_name: user.lastName,
      },
    };
  }

  async refreshToken(input: RefreshTokenType) {
    const jwtSecret = process.env["JWT_SECRET"];
    if (!jwtSecret) {
      throw new Error("JWT_SECRET environment variable is not set");
    }

    try {
      // Verify refresh token
      const payload = await verify(input.refresh_token, jwtSecret) as any;
      
      if (payload.type !== "refresh") {
        throw new InvalidRefreshTokenError("Invalid token type");
      }

      // Check if token exists in database and is not revoked
      const tokenHash = createHash('sha256').update(input.refresh_token).digest('hex');
      const storedToken = await this.db.query.refreshTokens.findFirst({
        where: and(
          eq(schema.refreshTokens.tokenHash, tokenHash),
          isNull(schema.refreshTokens.revokedAt),
          gte(schema.refreshTokens.expiresAt, new Date())
        )
      });

      if (!storedToken) {
        throw new InvalidRefreshTokenError("Refresh token is invalid or expired");
      }

      // Revoke old refresh token
      await this.db
        .update(schema.refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(schema.refreshTokens.id, storedToken.id));

      // Generate new tokens
      const tokens = await this.generateTokens(storedToken.userId);

      return tokens;
    } catch (error) {
      if (error instanceof InvalidRefreshTokenError) {
        throw error;
      }
      console.error("Error refreshing token:", error);
      throw new InvalidRefreshTokenError("Refresh token is invalid or expired");
    }
  }

  async logout(input: RefreshTokenType) {
    try {
      const tokenHash = createHash('sha256').update(input.refresh_token).digest('hex');
      
      // Revoke the refresh token
      const result = await this.db
        .update(schema.refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(
          eq(schema.refreshTokens.tokenHash, tokenHash),
          isNull(schema.refreshTokens.revokedAt)
        ))
        .returning();

      if (result.length === 0) {
        throw new InvalidRefreshTokenError("Token is invalid or already expired");
      }

      return { message: "Successfully logged out" };
    } catch (error) {
      if (error instanceof InvalidRefreshTokenError) {
        throw error;
      }
      console.error("Error logging out:", error);
      throw new InvalidRefreshTokenError("Token is invalid or already expired");
    }
  }
}
