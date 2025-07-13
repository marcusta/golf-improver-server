# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Tech Stack
- **Runtime**: Bun (Node.js alternative)
- **Framework**: Hono (lightweight web framework)
- **API**: oRPC (type-safe RPC framework)
- **Database**: SQLite with Drizzle ORM
- **Language**: TypeScript with strict configuration
- **Testing**: Bun's built-in test runner

## Development Commands

### Core Development
```bash
bun install          # Install dependencies
bun run dev          # Start development server with watch mode
bun start            # Start production server
bun run build        # Build for production
bun run build:clean  # Clean build directory and rebuild
```

### Database Management
```bash
bun run db:generate  # Generate database migrations from schema
bun run db:migrate   # Run pending migrations
bun run db:studio    # Open Drizzle Studio (database GUI)
bun run db:seed      # Seed database with initial data
```

### Quality Assurance
```bash
bun run type-check   # TypeScript type checking
bun run lint         # ESLint linting
bun run lint:fix     # Auto-fix linting issues
bun run format       # Format code with Prettier
bun run check-all    # Run type-check, lint, and test in sequence
```

### Testing
```bash
bun test             # Run all tests
bun test --watch     # Run tests in watch mode
bun test --coverage  # Run tests with coverage report
```


## Architecture Overview

### Project Structure
- **`src/server.ts`**: Main entry point, configures database and starts Hono server
- **`src/app.ts`**: Hono application factory with middleware setup
- **`src/api/`**: oRPC API layer with type-safe procedures
- **`src/services/`**: Business logic layer with dependency injection
- **`src/db/`**: Database schema, migrations, and utilities
- **`drizzle/`**: Generated migration files

### Key Architectural Patterns

#### 1. Dependency Injection
Services are created in `src/services/index.ts` and injected throughout the application:
```typescript
const services = createServices(database);
const { rpcHandler, router } = createApp(services);
```

#### 2. oRPC API Layer
- Type-safe RPC procedures defined in `src/api/orpc-api.ts`
- Middleware pipeline for auth, logging, performance, and audit
- Clean separation between procedures and middleware application

#### 3. Middleware Stack
Applied in order:
1. Error handling (catches all errors)
2. Request logging
3. Performance monitoring
4. Authentication (skipped for auth endpoints)
5. Audit logging (skipped for certain endpoints)

#### 4. Database Layer
- SQLite with Drizzle ORM for type safety
- Schema defined in `src/db/schema.ts`
- Migrations managed via Drizzle Kit

### Path Aliases
The following TypeScript path aliases are configured:
- `@/*` → `./src/*`
- `@/db/*` → `./src/db/*`
- `@/services/*` → `./src/services/*`
- `@/api/*` → `./src/api/*`

## Development Workflow

1. **Database Changes**: Update schema → generate migration → run migration
2. **API Changes**: Update procedures in `orpc-api.ts` → services handle business logic
3. **Testing**: Write tests alongside code, run `bun run check-all` before commits
4. **Quality**: Use strict TypeScript configuration and ESLint rules

## Database Seeding

The application automatically seeds the database with initial data on startup:

### Seed Data (`src/db/seed_data.json`)
- **Test Templates**: 5 predefined putting tests (PGA Tour, 18-hole, 9-hole, short game, long range)
- **Demo User**: `demo@putting-test.com` with password `demo123`
- **Sample Rounds**: 2 example rounds with complete hole-by-hole data

### Seeding Behavior
- Runs automatically on server startup
- Only inserts data if it doesn't already exist (idempotent)
- Logs detailed progress for each item seeded
- Safe to run multiple times without duplicating data

## Environment Variables
- `DB_FILE_NAME`: SQLite database file path
- `JWT_SECRET`: Secret for JWT token signing/verification

## Server Endpoints
- `/`: Status endpoint showing available procedures
- `/health`: Health check endpoint
- `/rpc/*`: oRPC API endpoints with authentication

## Demo Data Access
After startup, you can test with the demo user:
- **Email**: `demo@putting-test.com`
- **Password**: `demo123`
- **Sample Rounds**: 2 rounds already available for testing