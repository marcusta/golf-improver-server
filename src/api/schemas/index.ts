/**
 * Main schema export file for the application
 *
 * This barrel file re-exports all schemas and types from domain-specific modules,
 * providing a convenient single import point for consuming code.
 */

// ========================================
// Common Schemas & Types
// ========================================
export * from "./common";

// ========================================
// Authentication & User Management
// ========================================
export * from "./auth";

// ========================================
// Test Templates
// ========================================
export * from "./tests";

// ========================================
// Rounds Management
// ========================================
export * from "./rounds";

// ========================================
// User Profile
// ========================================
export * from "./user";

// ========================================
// Note: All schemas and types are automatically available via wildcard exports above
// The wildcard exports (export * from "./module") handle all the necessary re-exports
// ========================================
