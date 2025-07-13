import { z } from "zod";

// ========================================
// Test Templates Schemas
// ========================================
export const TestTemplateSchema = z.object({
  testId: z.string(),
  name: z.string(),
  description: z.string(),
  holeCount: z.number().int().positive(),
  distances: z.array(z.number().min(0.1).max(50.0)),
});

export const CreateTestTemplateSchema = z.object({
  testId: z.string().min(1, "Test ID is required").regex(/^[a-z0-9-]+$/, "Test ID must contain only lowercase letters, numbers, and hyphens"),
  name: z.string().min(1, "Name is required").max(100, "Name must be less than 100 characters"),
  description: z.string().min(1, "Description is required").max(500, "Description must be less than 500 characters"),
  holeCount: z.number().int().min(1, "Must have at least 1 hole").max(18, "Cannot have more than 18 holes"),
  distances: z.array(z.number().min(0.1, "Distance must be at least 0.1 meters").max(50.0, "Distance cannot exceed 50 meters"))
    .min(1, "Must have at least one distance"),
});

export const CreateTestTemplateResponseSchema = z.object({
  testId: z.string(),
  name: z.string(),
  description: z.string(),
  holeCount: z.number(),
  distances: z.array(z.number()),
  createdAt: z.string(),
});

export const ListTestsResponseSchema = z.object({
  tests: z.array(TestTemplateSchema),
});

// ========================================
// Type Exports
// ========================================
export type TestTemplateType = z.infer<typeof TestTemplateSchema>;
export type CreateTestTemplateType = z.infer<typeof CreateTestTemplateSchema>;
export type CreateTestTemplateResponseType = z.infer<typeof CreateTestTemplateResponseSchema>;
export type ListTestsResponseType = z.infer<typeof ListTestsResponseSchema>;