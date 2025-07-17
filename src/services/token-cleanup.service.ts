import type { Database } from "bun:sqlite";
import { and, lt, isNotNull } from "drizzle-orm";
import { getDb } from "../db";
import * as schema from "../db/schema";

export class TokenCleanupService {
  private db: ReturnType<typeof getDb>;

  constructor(database: Database) {
    this.db = getDb(database);
  }

  /**
   * Removes expired refresh tokens from the database
   * Should be called periodically (e.g., daily via cron job)
   */
  async cleanupExpiredTokens(): Promise<number> {
    const now = new Date();
    
    try {
      const deletedTokens = await this.db
        .delete(schema.refreshTokens)
        .where(lt(schema.refreshTokens.expiresAt, now))
        .returning();

      console.log(`Cleaned up ${deletedTokens.length} expired refresh tokens`);
      return deletedTokens.length;
    } catch (error) {
      console.error("Error cleaning up expired tokens:", error);
      throw error;
    }
  }

  /**
   * Removes revoked tokens that are also expired
   * This is a more aggressive cleanup for tokens that are both revoked and expired
   */
  async cleanupRevokedTokens(): Promise<number> {
    const now = new Date();
    
    try {
      const deletedTokens = await this.db
        .delete(schema.refreshTokens)
        .where(
          and(
            isNotNull(schema.refreshTokens.revokedAt),
            lt(schema.refreshTokens.expiresAt, now)
          )
        )
        .returning();

      console.log(`Cleaned up ${deletedTokens.length} revoked and expired refresh tokens`);
      return deletedTokens.length;
    } catch (error) {
      console.error("Error cleaning up revoked tokens:", error);
      throw error;
    }
  }

  /**
   * Gets statistics about token usage
   */
  async getTokenStatistics(): Promise<{
    totalTokens: number;
    expiredTokens: number;
    revokedTokens: number;
    activeTokens: number;
  }> {
    const now = new Date();
    
    try {
      const allTokens = await this.db.select().from(schema.refreshTokens);
      
      const totalTokens = allTokens.length;
      const expiredTokens = allTokens.filter(token => token.expiresAt < now).length;
      const revokedTokens = allTokens.filter(token => token.revokedAt !== null).length;
      const activeTokens = allTokens.filter(token => 
        token.expiresAt >= now && token.revokedAt === null
      ).length;

      return {
        totalTokens,
        expiredTokens,
        revokedTokens,
        activeTokens
      };
    } catch (error) {
      console.error("Error getting token statistics:", error);
      throw error;
    }
  }

  /**
   * Comprehensive cleanup that should be run daily
   * Returns total number of tokens cleaned up
   */
  async performDailyCleanup(): Promise<number> {
    console.log("Starting daily token cleanup...");
    
    const expiredCount = await this.cleanupExpiredTokens();
    const revokedCount = await this.cleanupRevokedTokens();
    const totalCleaned = expiredCount + revokedCount;
    
    const stats = await this.getTokenStatistics();
    console.log("Token cleanup complete:", {
      cleanedUp: totalCleaned,
      remaining: stats.totalTokens,
      active: stats.activeTokens
    });
    
    return totalCleaned;
  }
}