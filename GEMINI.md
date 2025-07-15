# Gemini Code Assistant Context

This document provides context for the Gemini code assistant to understand the project structure, commands, and conventions.

## Project Overview

This project is a server for a golf improvement application. It is built with Bun, TypeScript, Hono, and Drizzle ORM.

## Project Structure

- `src/`: Main source code directory.
  - `api/`: Hono API routes and schemas.
  - `db/`: Drizzle ORM schema, migrations, and seeding.
  - `services/`: Business logic services.
  - `app.ts`: Hono application setup.
  - `server.ts`: Main server entry point.
- `drizzle/`: Drizzle migration files.
- `tests/`: Test files.

## Common Commands

### Installation

Install dependencies with:

```bash
bun install
```

### Development

Run the development server with:

```bash
bun run dev
```

### Running the application

To run the application:

```bash
bun start
```

### Building

Build the project with:

```bash
bun run build
```

### Testing

Run tests with:
```bash
bun test
```

Run tests in watch mode with:
```bash
bun test:watch
```

Run tests with coverage:
```bash
bun test:coverage
```

### Linting

Run the linter with:
```bash
bun run lint
```

Fix linting errors with:
```bash
bun run lint:fix
```

### Type Checking

Run the type checker with:
```bash
bun run type-check
```

### All checks

Run all checks (type-checking, linting, and testing) with:
```bash
bun run check-all
```

### Database

Generate database migrations with:
```bash
bun run db:generate
```

Run database migrations with:
```bash
bun run db:migrate
```

Seed the database with:
```bash
bun run db:seed
```

Start the Drizzle Studio with:
```bash
bun run db:studio
```
