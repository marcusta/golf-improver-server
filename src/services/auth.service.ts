import type { Database } from "bun:sqlite";
import "dotenv/config";
import { eq } from "drizzle-orm";
import { sign } from "hono/jwt";
import type { LoginUserType, RegisterUserType } from "../api/schemas/auth";
import { getDb } from "../db";
import * as schema from "../db/schema";
import { NotFoundError } from "./errors";

export class AuthService {
  private db: ReturnType<typeof getDb>;

  constructor(database: Database) {
    this.db = getDb(database);
  }

  async register(input: RegisterUserType) {
    try {
      const existingUser = await this.db.query.users.findFirst({
        where: eq(schema.users.email, input.email),
      });

      if (existingUser) {
        // Use generic error to prevent email enumeration during registration
        throw new Error("Registration failed. Please try again with different details.");
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

      const jwtSecret = process.env["JWT_SECRET"];
      if (!jwtSecret) {
        throw new Error("JWT_SECRET environment variable is not set");
      }

      // Add JWT expiration (24 hours)
      const expirationTime = Math.floor(Date.now() / 1000) + (24 * 60 * 60);
      const token = await sign({ 
        userId: newUser[0]!.id,
        exp: expirationTime 
      }, jwtSecret);

      return {
        token,
        user: {
          id: newUser[0]!.id,
          email: newUser[0]!.email,
          firstName: newUser[0]!.firstName,
          lastName: newUser[0]!.lastName,
          createdAt: new Date(newUser[0]!.createdAt).toISOString(),
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
      throw new NotFoundError("Invalid email or password");
    }

    await this.db
      .update(schema.users)
      .set({ lastLoginAt: new Date() })
      .where(eq(schema.users.id, user.id));

    const jwtSecret = process.env["JWT_SECRET"];
    if (!jwtSecret) {
      throw new Error("JWT_SECRET environment variable is not set");
    }

    // Add JWT expiration (24 hours)
    const expirationTime = Math.floor(Date.now() / 1000) + (24 * 60 * 60);
    const token = await sign({ 
      userId: user.id,
      exp: expirationTime 
    }, jwtSecret);

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        lastLoginAt: new Date().toISOString(),
      },
    };
  }
}
