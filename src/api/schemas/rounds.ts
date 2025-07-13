import { z } from "zod";

// ========================================
// Round Hole Schema
// ========================================
export const HoleResultSchema = z.object({
  hole: z.number().int().min(1),
  distance: z.number().min(0.1).max(50.0),
  putts: z.number().int().min(1).max(10),
});

// ========================================
// Round Management Schemas
// ========================================
export const CreateRoundSchema = z.object({
  testId: z.string(),
  testName: z.string(),
  date: z.string().datetime(),
  holes: z.array(HoleResultSchema),
});

export const ListRoundsSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50).optional(),
  offset: z.number().int().min(0).default(0).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export const GetRoundSchema = z.object({
  roundId: z.string().uuid(),
});

// ========================================
// Response Schemas
// ========================================
export const RoundSummarySchema = z.object({
  roundId: z.string(),
  testId: z.string(),
  testName: z.string(),
  date: z.string(),
  totalPutts: z.number().int(),
  holesCompleted: z.number().int(),
});

export const CreateRoundResponseSchema = z.object({
  roundId: z.string(),
  userId: z.string(),
  testId: z.string(),
  testName: z.string(),
  totalPutts: z.number().int(),
  createdAt: z.string(),
  completedAt: z.string(),
});

export const RoundDetailsSchema = z.object({
  roundId: z.string(),
  userId: z.string(),
  testId: z.string(),
  testName: z.string(),
  date: z.string(),
  totalPutts: z.number().int(),
  holes: z.array(HoleResultSchema),
  createdAt: z.string(),
  completedAt: z.string(),
});

export const PaginationSchema = z.object({
  total: z.number().int(),
  offset: z.number().int(),
  limit: z.number().int(),
  hasMore: z.boolean(),
});

export const ListRoundsResponseSchema = z.object({
  rounds: z.array(RoundSummarySchema),
  pagination: PaginationSchema,
});

// ========================================
// Type Exports
// ========================================
export type HoleResultType = z.infer<typeof HoleResultSchema>;
export type CreateRoundType = z.infer<typeof CreateRoundSchema>;
export type ListRoundsType = z.infer<typeof ListRoundsSchema>;
export type GetRoundType = z.infer<typeof GetRoundSchema>;
export type RoundSummaryType = z.infer<typeof RoundSummarySchema>;
export type CreateRoundResponseType = z.infer<typeof CreateRoundResponseSchema>;
export type RoundDetailsType = z.infer<typeof RoundDetailsSchema>;
export type PaginationType = z.infer<typeof PaginationSchema>;
export type ListRoundsResponseType = z.infer<typeof ListRoundsResponseSchema>;