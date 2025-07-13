import { z } from "zod";

// ========================================
// Authentication Schemas (API Spec)
// ========================================
export const RegisterUserSchema = z.object({
  email: z.string().email("Valid email is required"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128, "Password must be less than 128 characters")
    .regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/, 
           "Password must contain lowercase, uppercase, number, and special character"),
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
});

export const LoginUserSchema = z.object({
  email: z.string().email("Valid email is required"),
  password: z.string().min(1, "Password is required"),
});

// ========================================
// Type Exports
// ========================================
export type RegisterUserType = z.infer<typeof RegisterUserSchema>;
export type LoginUserType = z.infer<typeof LoginUserSchema>;
