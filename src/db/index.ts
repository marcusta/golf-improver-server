import { Database } from "bun:sqlite";
import "dotenv/config";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";

export const dbFile = process.env["DB_FILE_NAME"];
if (!dbFile) {
  throw new Error("DB_FILE_NAME environment variable is not set");
}
const sqlite = new Database(dbFile);
export const db = drizzle(sqlite, { schema });

export const getDb = (database: Database) => {
  return drizzle(database, { schema });
};

export * from "./schema";
