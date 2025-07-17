import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { randomUUID } from "node:crypto";

// =================================================================
// Putting Test Suite Schema
// =================================================================

export const users = sqliteTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  lastLoginAt: integer("last_login_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const testTemplates = sqliteTable("test_templates", {
  id: text("id").primaryKey(), // e.g., "putting-18", "putting-9"
  name: text("name").notNull(), // e.g., "18-Hole Putting Test"
  description: text("description").notNull(),
  holeCount: integer("hole_count").notNull(),
  distances: text("distances", { mode: "json" }).notNull(), // Array of distances in meters
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const rounds = sqliteTable("rounds", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  testId: text("test_id")
    .notNull()
    .references(() => testTemplates.id),
  testName: text("test_name").notNull(), // Denormalized for performance
  date: integer("date", { mode: "timestamp" }).notNull(), // When the round was played
  totalPutts: integer("total_putts").notNull(),
  holesCompleted: integer("holes_completed").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  completedAt: integer("completed_at", { mode: "timestamp" }).notNull(),
});

export const holeResults = sqliteTable("hole_results", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  roundId: text("round_id")
    .notNull()
    .references(() => rounds.id, { onDelete: "cascade" }),
  hole: integer("hole").notNull(), // Hole number (1-based)
  distance: real("distance").notNull(), // Distance in meters
  putts: integer("putts").notNull(), // Number of putts taken
});

export const refreshTokens = sqliteTable("refresh_tokens", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash", { length: 512 }).notNull().unique(), // SHA-256 hash of refresh token
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  revokedAt: integer("revoked_at", { mode: "timestamp" }), // NULL = active, timestamp = revoked
});
