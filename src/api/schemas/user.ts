import { z } from "zod";

// ========================================
// User Profile Schemas
// ========================================
export const UserProfileSchema = z.object({
  id: z.string(),
  email: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  createdAt: z.string(),
  lastLoginAt: z.string().nullable(),
});

export const UserStatsSchema = z.object({
  totalRounds: z.number().int(),
  totalPutts: z.number().int(),
  averagePuttsPerRound: z.number(),
  bestRound: z.number().int(),
  worstRound: z.number().int(),
});

export const UserProfileResponseSchema = z.object({
  user: UserProfileSchema,
  stats: UserStatsSchema,
});

// ========================================
// Type Exports
// ========================================
export type UserProfileType = z.infer<typeof UserProfileSchema>;
export type UserStatsType = z.infer<typeof UserStatsSchema>;
export type UserProfileResponseType = z.infer<typeof UserProfileResponseSchema>;