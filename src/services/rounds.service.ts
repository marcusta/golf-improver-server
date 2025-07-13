import type { Database } from "bun:sqlite";
import { and, count, desc, eq, gte, lte, max, min, sum } from "drizzle-orm";
import type { CreateRoundType, GetRoundType, ListRoundsType } from "../api/schemas/rounds";
import { getDb } from "../db";
import * as schema from "../db/schema";
import { NotFoundError } from "./errors";

export class RoundsService {
  private db: ReturnType<typeof getDb>;

  constructor(database: Database) {
    this.db = getDb(database);
  }

  async createRound(input: CreateRoundType, userId: string) {
    const roundId = crypto.randomUUID();
    const now = new Date();
    const date = new Date(input.date);
    
    const totalPutts = input.holes.reduce((sum, hole) => sum + hole.putts, 0);

    const newRound = await this.db
      .insert(schema.rounds)
      .values({
        id: roundId,
        userId,
        testId: input.testId,
        testName: input.testName,
        date,
        totalPutts,
        holesCompleted: input.holes.length,
        completedAt: now,
      })
      .returning();

    const holeResults = input.holes.map((hole) => ({
      roundId,
      hole: hole.hole,
      distance: hole.distance,
      putts: hole.putts,
    }));

    await this.db.insert(schema.holeResults).values(holeResults);

    return {
      roundId: newRound[0]!.id,
      userId: newRound[0]!.userId,
      testId: newRound[0]!.testId,
      testName: newRound[0]!.testName,
      totalPutts: newRound[0]!.totalPutts,
      createdAt: new Date(newRound[0]!.createdAt).toISOString(),
      completedAt: new Date(newRound[0]!.completedAt).toISOString(),
    };
  }

  async listRounds(input: ListRoundsType, userId: string) {
    const { limit = 50, offset = 0, from, to } = input;

    const conditions = [eq(schema.rounds.userId, userId)];
    
    if (from) {
      conditions.push(gte(schema.rounds.date, new Date(from)));
    }
    
    if (to) {
      conditions.push(lte(schema.rounds.date, new Date(to)));
    }

    const whereClause = conditions.length > 1 ? and(...conditions) : conditions[0];

    const [rounds, totalCountResult] = await Promise.all([
      this.db.query.rounds.findMany({
        where: whereClause,
        orderBy: desc(schema.rounds.date),
        limit,
        offset,
      }),
      this.db
        .select({ count: count() })
        .from(schema.rounds)
        .where(whereClause),
    ]);

    const total = totalCountResult[0]?.count || 0;

    return {
      rounds: rounds.map((round) => ({
        roundId: round.id,
        testId: round.testId,
        testName: round.testName,
        date: new Date(round.date).toISOString(),
        totalPutts: round.totalPutts,
        holesCompleted: round.holesCompleted,
      })),
      pagination: {
        total,
        offset,
        limit,
        hasMore: offset + limit < total,
      },
    };
  }

  async getRound(input: GetRoundType, userId: string) {
    const round = await this.db.query.rounds.findFirst({
      where: and(
        eq(schema.rounds.id, input.roundId),
        eq(schema.rounds.userId, userId)
      ),
    });

    if (!round) {
      throw new NotFoundError("Round not found");
    }

    const holes = await this.db.query.holeResults.findMany({
      where: eq(schema.holeResults.roundId, round.id),
      orderBy: schema.holeResults.hole,
    });

    return {
      roundId: round.id,
      userId: round.userId,
      testId: round.testId,
      testName: round.testName,
      date: new Date(round.date).toISOString(),
      totalPutts: round.totalPutts,
      holes: holes.map((hole) => ({
        hole: hole.hole,
        distance: hole.distance,
        putts: hole.putts,
      })),
      createdAt: new Date(round.createdAt).toISOString(),
      completedAt: new Date(round.completedAt).toISOString(),
    };
  }

  async getUserStats(userId: string) {
    const statsQuery = await this.db
      .select({
        totalRounds: count(),
        totalPutts: sum(schema.rounds.totalPutts),
        bestRound: min(schema.rounds.totalPutts),
        worstRound: max(schema.rounds.totalPutts),
      })
      .from(schema.rounds)
      .where(eq(schema.rounds.userId, userId));

    const stats = statsQuery[0];
    
    if (!stats || stats.totalRounds === 0) {
      return {
        totalRounds: 0,
        totalPutts: 0,
        averagePuttsPerRound: 0,
        bestRound: 0,
        worstRound: 0,
      };
    }

    return {
      totalRounds: stats.totalRounds,
      totalPutts: stats.totalPutts || 0,
      averagePuttsPerRound: stats.totalPutts && stats.totalRounds ? Number((Number(stats.totalPutts) / Number(stats.totalRounds)).toFixed(1)) : 0,
      bestRound: stats.bestRound || 0,
      worstRound: stats.worstRound || 0,
    };
  }
}