import type { Database } from "bun:sqlite";
import { getDb } from "../db";
import * as schema from "../db/schema";

export interface TestDataSet {
  users: {
    testUser: any;
    testUser2: any;
  };
  testTemplates: {
    putting18: any;
    putting9: any;
  };
  rounds: {
    testRound1: any;
    testRound2: any;
  };
}

/**
 * Creates a complete test dataset with all necessary foreign key relationships
 */
export async function createTestDataSet(
  database: Database
): Promise<TestDataSet> {
  const db = getDb(database);

  // Use SeedService to seed the database with initial data
  const { SeedService } = await import("../services/seed.service");
  const seedService = new SeedService(database);
  await seedService.seedDatabase();

  // Create additional test users for testing
  const testUser = await db
    .insert(schema.users)
    .values({
      firstName: "Test",
      lastName: "User",
      email: "test@example.com",
      passwordHash: await Bun.password.hash("Password123!"),
    })
    .returning();

  const testUser2 = await db
    .insert(schema.users)
    .values({
      firstName: "Test",
      lastName: "User 2",
      email: "test2@example.com",
      passwordHash: await Bun.password.hash("Password123!"),
    })
    .returning();

  // Create additional test rounds
  const now = new Date();
  const testRounds = await db
    .insert(schema.rounds)
    .values([
      {
        userId: testUser[0]!.id,
        testId: "putting-18",
        testName: "18-Hole Putting Test",
        date: new Date(Date.now() - 86400000), // 1 day ago
        totalPutts: 36,
        holesCompleted: 18,
        completedAt: now,
      },
      {
        userId: testUser2[0]!.id,
        testId: "putting-9",
        testName: "9-Hole Putting Test",
        date: new Date(Date.now() - 172800000), // 2 days ago
        totalPutts: 18,
        holesCompleted: 9,
        completedAt: now,
      },
    ])
    .returning();

  // Create hole results for test rounds
  await db.insert(schema.holeResults).values([
    // Test round 1 holes (18 holes)
    ...Array.from({ length: 18 }, (_, i) => ({
      roundId: testRounds[0]!.id,
      hole: i + 1,
      distance: [1.5, 12.0, 0.6, 4.0, 1.2, 16.0, 8.0, 3.0, 6.0, 9.0, 0.9, 7.0, 2.1, 3.5, 10.0, 1.8, 5.0, 2.4][i]!,
      putts: Math.floor(Math.random() * 3) + 1, // 1-3 putts
    })),
    // Test round 2 holes (9 holes)
    ...Array.from({ length: 9 }, (_, i) => ({
      roundId: testRounds[1]!.id,
      hole: i + 1,
      distance: [1.5, 12.0, 0.6, 4.0, 1.2, 16.0, 8.0, 3.0, 6.0][i]!,
      putts: Math.floor(Math.random() * 3) + 1, // 1-3 putts
    })),
  ]);

  // Get the seeded templates
  const putting18 = await db.query.testTemplates.findFirst({
    where: (templates, { eq }) => eq(templates.id, "putting-18"),
  });
  const putting9 = await db.query.testTemplates.findFirst({
    where: (templates, { eq }) => eq(templates.id, "putting-9"),
  });

  return {
    users: {
      testUser: testUser[0],
      testUser2: testUser2[0],
    },
    testTemplates: {
      putting18: putting18!,
      putting9: putting9!,
    },
    rounds: {
      testRound1: testRounds[0],
      testRound2: testRounds[1],
    },
  };
}

/**
 * Setup test environment variables
 */
export function setupTestEnvironment() {
  process.env["JWT_SECRET"] = "test-secret-key-for-jwt-signing-in-tests";
  process.env["NODE_ENV"] = "test";
}

/**
 * Clean test environment
 */
export function cleanTestEnvironment() {
  delete process.env["JWT_SECRET"];
  delete process.env["NODE_ENV"];
}
