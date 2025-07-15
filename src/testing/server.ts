import { serve, type Server } from "bun";
import { Database } from "bun:sqlite";
import { createHonoApp } from "../app";
import { createTestDatabase as createMigratedTestDatabase } from "../db/migrate";
import { createServices, type Services } from "../services";

// Store active test servers for cleanup
const activeServers = new Map<Database, { server: Server; port: number }>();

/**
 * Creates and returns a new in-memory bun:sqlite database instance with migrations applied
 * @returns Database instance configured for in-memory use with full schema
 */
export async function createTestDatabase(): Promise<Database> {
  // Use the migration-based approach to create a properly set up test database
  return await createMigratedTestDatabase();
}

/**
 * Creates services for testing with the given database
 * @param database - Database instance to inject into services
 * @returns Services container for testing
 */
export function createTestServices(database: Database): Services {
  return createServices(database);
}

/**
 * Takes a database instance, starts a new server on a random free port,
 * and returns the server's port number
 * @param db - Database instance to use for the server
 * @returns Promise that resolves to the port number
 */
export async function setupTestServer(db: Database): Promise<number> {
  const { app } = createHonoApp(db);

  // Start server on a random port
  const server = serve({
    fetch: app.fetch,
    port: 0, // Let Bun assign a random port
  });

  const port = server.port;
  if (!port) {
    throw new Error("Failed to get server port");
  }

  // Store the server for cleanup
  activeServers.set(db, { server, port });

  return port;
}

/**
 * Stops the server associated with the given database instance
 * @param db - Database instance whose server should be stopped
 */
export async function stopTestServer(db: Database): Promise<void> {
  const serverInfo = activeServers.get(db);

  if (serverInfo) {
    serverInfo.server.stop();
    activeServers.delete(db);
  }

  // Close the database
  db.close();
}

/**
 * Cleanup function to stop all active test servers
 */
export async function stopAllTestServers(): Promise<void> {
  const databases = Array.from(activeServers.keys());
  await Promise.all(databases.map((db) => stopTestServer(db)));
}
