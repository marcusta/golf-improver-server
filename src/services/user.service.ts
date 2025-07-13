import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import * as schema from "../db/schema";
import { NotFoundError } from "./errors";
import { RoundsService } from "./rounds.service";

export class UserService {
  private db: ReturnType<typeof getDb>;
  private roundsService: RoundsService;

  constructor(database: Database) {
    this.db = getDb(database);
    this.roundsService = new RoundsService(database);
  }

  async getProfile(userId: string) {
    const user = await this.db.query.users.findFirst({
      where: eq(schema.users.id, userId),
    });

    if (!user) {
      throw new NotFoundError("User not found");
    }

    const stats = await this.roundsService.getUserStats(userId);

    return {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        createdAt: new Date(user.createdAt).toISOString(),
        lastLoginAt: user.lastLoginAt ? new Date(user.lastLoginAt).toISOString() : null,
      },
      stats,
    };
  }
}