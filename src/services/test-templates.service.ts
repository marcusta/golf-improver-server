import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import * as schema from "../db/schema";
import { ValidationError } from "./errors";
import type { CreateTestTemplateType } from "../api/schemas/tests";

export class TestTemplatesService {
  private db: ReturnType<typeof getDb>;

  constructor(database: Database) {
    this.db = getDb(database);
  }

  async listTests() {
    const tests = await this.db.query.testTemplates.findMany({
      orderBy: schema.testTemplates.name,
    });

    return {
      tests: tests.map((test) => ({
        testId: test.id,
        name: test.name,
        description: test.description,
        holeCount: test.holeCount,
        distances: test.distances as number[],
      })),
    };
  }

  async createTestTemplate(input: CreateTestTemplateType) {
    // Check if test template with this ID already exists
    const existingTemplate = await this.db.query.testTemplates.findFirst({
      where: eq(schema.testTemplates.id, input.testId),
    });

    if (existingTemplate) {
      throw new ValidationError(`Test template with ID '${input.testId}' already exists`);
    }

    // Validate that distances array length matches holeCount
    if (input.distances.length !== input.holeCount) {
      throw new ValidationError("Number of distances must match hole count");
    }

    const createdTemplate = await this.db
      .insert(schema.testTemplates)
      .values({
        id: input.testId,
        name: input.name,
        description: input.description,
        holeCount: input.holeCount,
        distances: input.distances,
      })
      .returning();

    const template = createdTemplate[0]!;

    return {
      testId: template.id,
      name: template.name,
      description: template.description,
      holeCount: template.holeCount,
      distances: template.distances as number[],
      createdAt: template.createdAt.toISOString(),
    };
  }

}