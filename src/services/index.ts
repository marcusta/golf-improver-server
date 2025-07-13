import type { Database } from "bun:sqlite";
import { AuthService } from "./auth.service";
import { RoundsService } from "./rounds.service";
import { SeedService } from "./seed.service";
import { TestTemplatesService } from "./test-templates.service";
import { UserService } from "./user.service";

export interface Services {
  auth: AuthService;
  testTemplates: TestTemplatesService;
  rounds: RoundsService;
  user: UserService;
  seed: SeedService;
}

/**
 * Creates all services with dependency injection
 * @param database - Database instance to inject into all services
 * @returns Services container with all business logic services
 */
export function createServices(database: Database): Services {
  return {
    auth: new AuthService(database),
    testTemplates: new TestTemplatesService(database),
    rounds: new RoundsService(database),
    user: new UserService(database),
    seed: new SeedService(database),
  };
}
