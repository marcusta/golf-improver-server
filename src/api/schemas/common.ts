import { z } from "zod";

// ========================================
// Base Reusable Schemas
// ========================================
export const UuidSchema = z.string().uuid();
export const VersionSchema = z.number().int().min(1);
export const DateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/); // YYYY-MM-DD

// ========================================
// Pagination & Response Schemas
// ========================================
export const PaginationParamsSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
});

export const PaginationMetaSchema = z.object({
  total: z.number().int().min(0),
  limit: z.number().int().min(1),
  offset: z.number().int().min(0),
  hasNext: z.boolean(),
  hasPrevious: z.boolean(),
});

export const ListResponseSchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.object({
    items: z.array(itemSchema),
    meta: PaginationMetaSchema,
  });

export const SuccessResponseSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
  data: z.any().optional(),
});

export const ErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.string(),
  code: z.string().optional(),
  details: z.any().optional(),
});

// ========================================
// Type Exports
// ========================================
export type UuidType = z.infer<typeof UuidSchema>;
export type VersionType = z.infer<typeof VersionSchema>;
export type DateStringType = z.infer<typeof DateStringSchema>;
export type PaginationParamsType = z.infer<typeof PaginationParamsSchema>;
export type PaginationMetaType = z.infer<typeof PaginationMetaSchema>;
export type SuccessResponseType = z.infer<typeof SuccessResponseSchema>;
export type ErrorResponseType = z.infer<typeof ErrorResponseSchema>;
