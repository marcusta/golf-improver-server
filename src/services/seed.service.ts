import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import * as schema from "../db/schema";
import seedData from "../db/seed_data.json";

export class SeedService {
  private db: ReturnType<typeof getDb>;

  constructor(database: Database) {
    this.db = getDb(database);
  }

  async seedDatabase() {
    console.log("🌱 Starting database seeding...");
    
    try {
      await this.seedTestTemplates();
      await this.seedDemoUser();
      await this.seedSampleRounds();
      console.log("✅ Database seeding completed successfully");
    } catch (error) {
      console.error("❌ Database seeding failed:", error);
      throw error;
    }
  }

  private async seedTestTemplates() {
    console.log("🌱 Seeding test templates...");
    
    for (const test of seedData.tests) {
      const existing = await this.db.query.testTemplates.findFirst({
        where: eq(schema.testTemplates.id, test.testId),
      });

      if (!existing) {
        await this.db.insert(schema.testTemplates).values({
          id: test.testId,
          name: test.name,
          description: test.description,
          holeCount: test.holeCount,
          distances: test.distances,
        });
        console.log(`  ✓ Created test template: ${test.name}`);
      } else {
        console.log(`  - Test template already exists: ${test.name}`);
      }
    }
  }

  private async seedDemoUser() {
    console.log("🌱 Seeding demo user...");
    
    const { demoUser } = seedData;
    const existing = await this.db.query.users.findFirst({
      where: eq(schema.users.id, demoUser.id),
    });

    if (!existing) {
      const passwordHash = await Bun.password.hash(demoUser.password);
      
      await this.db.insert(schema.users).values({
        id: demoUser.id,
        firstName: demoUser.firstName,
        lastName: demoUser.lastName,
        email: demoUser.email,
        passwordHash,
      });
      console.log(`  ✓ Created demo user: ${demoUser.email}`);
    } else {
      console.log(`  - Demo user already exists: ${demoUser.email}`);
    }
  }

  private async seedSampleRounds() {
    console.log("🌱 Seeding sample rounds...");
    
    for (const roundData of seedData.sampleRounds) {
      const existingRound = await this.db.query.rounds.findFirst({
        where: eq(schema.rounds.id, roundData.roundId),
      });

      if (!existingRound) {
        const totalPutts = roundData.holes.reduce((sum, hole) => sum + hole.putts, 0);
        const date = new Date(roundData.date);
        const now = new Date();

        // Create the round
        await this.db.insert(schema.rounds).values({
          id: roundData.roundId,
          userId: roundData.userId,
          testId: roundData.testId,
          testName: roundData.testName,
          date,
          totalPutts,
          holesCompleted: roundData.holes.length,
          completedAt: now,
        });

        // Create hole results
        const holeResults = roundData.holes.map((hole) => ({
          roundId: roundData.roundId,
          hole: hole.hole,
          distance: hole.distance,
          putts: hole.putts,
        }));

        await this.db.insert(schema.holeResults).values(holeResults);
        
        console.log(`  ✓ Created sample round: ${roundData.testName} (${totalPutts} putts)`);
      } else {
        console.log(`  - Sample round already exists: ${roundData.testName}`);
      }
    }
  }
}