import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { dbFile } from ".";

/**
 * Applies database migrations to the given database instance using Drizzle
 * @param database - Database instance to migrate
 * @param migrationsFolder - Optional path to migrations folder (defaults to ./drizzle)
 */
export async function applyMigrations(
  database: Database,
  migrationsFolder: string = "./drizzle",
): Promise<void> {
  const db = drizzle(database);

  try {
    // Apply migrations from the drizzle folder
    await migrate(db, { migrationsFolder });
  } catch (error) {
    console.error("Migration failed:", error);
    throw error;
  }
}

/**
 * Standalone migration script for production use
 * Run this script to apply migrations to the production database
 */
export async function runProductionMigrations(): Promise<void> {
  console.log("Bun Migration Script");

  let sqlite: Database | null = null;

  try {
    // Point to the production database file
    sqlite = new Database(dbFile);

    console.log("Running migrations...");

    // This will run all pending migrations
    await applyMigrations(sqlite, "./drizzle");

    console.log("Migrations applied successfully!");
  } catch (error) {
    console.error("Migration failed:");
    console.error(error);
    process.exit(1);
  } finally {
    if (sqlite) {
      sqlite.close();
    }
  }
}

/**
 * Creates and migrates a test database (in-memory)
 * @returns Database instance ready for testing
 */
export async function createTestDatabase(): Promise<Database> {
  // Create in-memory database
  const database = new Database(":memory:");

  // Apply all migrations to set up the schema
  await applyMigrations(database, "./drizzle");

  return database;
}

// If this file is run directly, execute production migrations
if (import.meta.main) {
  await runProductionMigrations();
}
