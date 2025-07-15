#!/usr/bin/env bun
/**
 * Advanced HTTP MCP Server with Database-Backed API Discovery
 *
 * This server provides intelligent API discovery, documentation, and execution
 * through a searchable SQLite database via HTTP transport.
 */

import { createServices } from "@/services/index.js";
import { Database } from "bun:sqlite";
import cors from "cors";
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { createHonoApp } from "../app.js";
import { SimpleAPIExtractor } from "./dynamic-api-extractor.js";
import { APIFileWatcher, createDefaultWatcher } from "./file-watcher.js";

// MCP types
interface MCPRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: any;
}

interface MCPResponse {
  jsonrpc: "2.0";
  id?: string | number | null | undefined;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

// Database path for API metadata
const API_DB_PATH = join(process.cwd(), "api-metadata.db");

// Global instances
let globalAPIDB: APIDatabase | null = null;
let globalAPIExecutor: APIExecutor | null = null;
let globalHonoApp: any = null;
let globalFileWatcher: APIFileWatcher | null = null;

// Server-side session state for authenticated agent access
const mcpSession: { authToken: string | null } = { authToken: null };

/**
 * Database service for API metadata operations
 */
class APIDatabase {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.initializeDatabase();
  }

  private initializeDatabase(): void {
    const schemaPath = join(__dirname, "api-metadata.sql");
    if (existsSync(schemaPath)) {
      const schema = readFileSync(schemaPath, "utf-8");
      this.db.exec(schema);
    }
  }

  /**
   * Search APIs using Full-Text Search (FTS) with intelligent query expansion
   */
  searchAPIs(query: string, limit: number = 10): any[] {
    try {
      const ftsQuery = this.db.prepare(`
        SELECT
          e.id,
          e.name,
          e.domain,
          e.method,
          e.description,
          e.category,
          e.requires_auth,
          e.http_path
        FROM api_endpoints e
        JOIN api_search s ON e.id = s.endpoint_id
        WHERE api_search MATCH ?
        ORDER BY rank
        LIMIT ?
      `);

      // Try different query variations for better results
      const queryVariations = [
        query, // Original query (exact phrase or AND behavior)
        query.split(" ").join(" OR "), // OR all terms together
        `"${query}"`, // Exact phrase search
      ];

      for (const variation of queryVariations) {
        try {
          const results = ftsQuery.all(variation, limit);
          if (results.length > 0) {
            console.log(
              `FTS found ${results.length} results with query variation: "${variation}"`
            );
            return results;
          }
        } catch (ftsError) {
          // Skip this variation if it has syntax errors
          console.log(`FTS variation "${variation}" failed, trying next...`);
          continue;
        }
      }

      // Fallback to LIKE search if all FTS variations fail or return no results
      console.log(
        "All FTS variations returned no results, falling back to LIKE search"
      );
      const fallbackQuery = this.db.prepare(`
        SELECT 
          e.id,
          e.name,
          e.domain,
          e.method,
          e.description,
          e.category,
          e.requires_auth,
          e.http_path
        FROM api_endpoints e
        WHERE e.description LIKE ? OR e.name LIKE ? OR e.category LIKE ?
        ORDER BY e.name
        LIMIT ?
      `);

      const searchTerm = `%${query}%`;
      console.log(
        `[DEBUG] Executing LIKE query with search term: "${searchTerm}"`
      );
      const fallbackResults = fallbackQuery.all(
        searchTerm,
        searchTerm,
        searchTerm,
        limit
      );
      console.log(
        `[DEBUG] LIKE query returned ${fallbackResults.length} results`
      );
      return fallbackResults;
    } catch (error) {
      console.error("Search error:", error);
      // Final fallback to LIKE search if FTS fails for some reason
      try {
        const fallbackQuery = this.db.prepare(`
          SELECT 
            e.id,
            e.name,
            e.domain,
            e.method,
            e.description,
            e.category,
            e.requires_auth,
            e.http_path
          FROM api_endpoints e
          WHERE e.description LIKE ? OR e.name LIKE ? OR e.category LIKE ?
          ORDER BY e.name
          LIMIT ?
        `);

        const searchTerm = `%${query}%`;
        return fallbackQuery.all(searchTerm, searchTerm, searchTerm, limit);
      } catch (fallbackError) {
        console.error("Fallback search also failed:", fallbackError);
        return [];
      }
    }
  }

  /**
   * Get detailed API information
   */
  getAPIDetails(apiName: string): any {
    const endpointQuery = this.db.prepare(`
      SELECT * FROM api_endpoints WHERE name = ?
    `);

    const endpoint = endpointQuery.get(apiName);
    if (!endpoint) return null;

    const parametersQuery = this.db.prepare(`
      SELECT * FROM api_parameters 
      WHERE endpoint_id = ? 
      ORDER BY parameter_type, parameter_name
    `);

    const parameters = parametersQuery.all((endpoint as any).id);

    return {
      ...endpoint,
      parameters,
    };
  }

  /**
   * Get examples for an API endpoint
   */
  getAPIExamples(apiName: string): any[] {
    const endpointQuery = this.db.prepare(`
      SELECT id FROM api_endpoints WHERE name = ?
    `);

    const endpoint = endpointQuery.get(apiName);
    if (!endpoint) return [];

    const examplesQuery = this.db.prepare(`
      SELECT * FROM api_examples 
      WHERE endpoint_id = ? 
      ORDER BY example_type, id
    `);

    return examplesQuery.all((endpoint as any).id);
  }

  /**
   * Execute raw SQL query
   */
  executeSQL(query: string): any[] {
    try {
      return this.db.prepare(query).all();
    } catch (error) {
      throw new Error(
        `SQL Error: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }

  /**
   * Get database schema for LLM to construct queries
   */
  getSchema(): string {
    return `
-- API Endpoints Table (Primary Data)
CREATE TABLE api_endpoints (
    id INTEGER PRIMARY KEY,
    name TEXT UNIQUE,           -- e.g., "auth.register"
    domain TEXT,                -- e.g., "auth" 
    method TEXT,                -- e.g., "register"
    description TEXT,           -- Human-readable description
    http_path TEXT,             -- e.g., "/rpc/auth.register"
    requires_auth BOOLEAN,      -- Whether auth is required
    category TEXT               -- e.g., "Authentication"
);

-- API Parameters Table  
CREATE TABLE api_parameters (
    id INTEGER PRIMARY KEY,
    endpoint_id INTEGER,        -- Foreign key to api_endpoints
    parameter_name TEXT,        -- Parameter name
    parameter_type TEXT,        -- "input" or "output"
    data_type TEXT,             -- "string", "number", "object", etc.
    is_required BOOLEAN,        -- Whether parameter is required
    description TEXT,           -- Parameter description
    example_value TEXT,         -- JSON example
    enum_values TEXT            -- JSON array of enum values
);

-- Full-Text Search Table (for 'natural' searchType)
-- This is a standalone virtual table optimized for searching.
CREATE VIRTUAL TABLE api_search USING fts5(
  endpoint_id UNINDEXED, -- Foreign key to api_endpoints.id
  name,
  description,
  category,
  parameters
);

-- Examples for constructing queries:
-- For natural language searches, use the 'natural' searchType. The server will use the 'api_search' table.
-- e.g., query: "user authentication"

-- For advanced SQL searches, use the 'sql' searchType. You can query the FTS table directly for powerful searches.
-- Find APIs related to both 'rounds' and 'tests':
--   SELECT name, description FROM api_endpoints
--   JOIN api_search ON api_endpoints.id = api_search.rowid
--   WHERE api_search MATCH 'rounds AND tests';
--
-- Find APIs related to 'user' but not 'delete':
--   SELECT name, description FROM api_endpoints
--   JOIN api_search ON api_endpoints.id = api_search.rowid
--   WHERE api_search MATCH 'user NOT delete';
--
-- Traditional SQL queries still work:
-- Find all authentication endpoints:
--   SELECT * FROM api_endpoints WHERE category = 'Authentication';
-- 
-- Search for rounds-related APIs:
--   SELECT * FROM api_endpoints WHERE name LIKE '%rounds%';
--
-- Get input parameters for an API:
--   SELECT * FROM api_parameters WHERE endpoint_id = (
--     SELECT id FROM api_endpoints WHERE name = 'rounds.create'
--   ) AND parameter_type = 'input';
`;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * API Executor - Handles direct HTTP calls to Hono routes
 */
class APIExecutor {
  // private _honoApp: any; // Reserved for future direct HTTP call execution
  private services: any;

  constructor(_honoApp: any, services: any) {
    // this._honoApp = _honoApp; // Reserved for future use
    this.services = services;
  }

  /**
   * Execute an API call directly through service layer
   */
  async executeAPI(
    apiName: string,
    input: any,
    authToken?: string
  ): Promise<any> {
    const [domain, method] = apiName.split(".");

    if (!domain || !method) {
      throw new Error(
        `Invalid API name format: ${apiName}. Expected format: domain.method`
      );
    }

    try {
      // Map domain to service name
      const serviceMapping: Record<string, string> = {
        auth: "auth",
        rounds: "rounds",
        tests: "testTemplates",
        user: "user",
      };

      const serviceName = serviceMapping[domain];
      if (!serviceName || !this.services[serviceName]) {
        throw new Error(`Service not found for domain: ${domain}`);
      }

      const service = this.services[serviceName];
      if (!service[method] || typeof service[method] !== "function") {
        throw new Error(`Method not found: ${domain}.${method}`);
      }

      // Create user context for authenticated calls
      let result;
      if (authToken) {
        // For authenticated calls, we need to decode the token to get user ID
        // For now, we'll use a mock user ID - in real implementation, decode JWT
        const mockUserId = "mcp-user";

        // Different services have different method signatures
        if (domain === "auth") {
          result = await service[method](input);
        } else if (domain === "rounds") {
          result = await service[method](input, mockUserId);
        } else if (domain === "user") {
          result = await service[method](mockUserId);
        } else {
          result = await service[method](input);
        }
      } else {
        // For public calls
        result = await service[method](input);
      }

      return {
        success: true,
        data: result,
        apiName,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        apiName,
        timestamp: new Date().toISOString(),
      };
    }
  }
}

/**
 * Initialize the API and database
 */
async function initializeAPI(): Promise<void> {
  console.log("[Advanced MCP Server] Initializing API...");

  // Create database connection
  const dbFileName = process.env["DB_FILE_NAME"];
  if (!dbFileName) {
    throw new Error("DB_FILE_NAME environment variable is not set");
  }

  const database = new Database(dbFileName);
  console.log(`[Advanced MCP Server] Connected to database: ${dbFileName}`);

  // Create services and Hono app
  const services = createServices(database);
  const { app } = createHonoApp(database);
  globalHonoApp = app;

  // Initialize API database and executor
  globalAPIDB = new APIDatabase(API_DB_PATH);
  globalAPIExecutor = new APIExecutor(globalHonoApp, services);

  // Extract comprehensive API metadata to database using dynamic extractor
  console.log("[Advanced MCP Server] Extracting comprehensive API metadata...");
  const apiFilePath = join(process.cwd(), "src/api/api.ts");
  const extractor = new SimpleAPIExtractor(
    API_DB_PATH,
    apiFilePath,
    process.cwd()
  );
  await extractor.extractFromAPI();
  extractor.close();

  // Setup file watcher for automatic updates
  console.log(
    "[Advanced MCP Server] Setting up file watcher for automatic updates..."
  );
  globalFileWatcher = createDefaultWatcher(API_DB_PATH, () => globalHonoApp);
  globalFileWatcher.start();

  console.log("[Advanced MCP Server] API metadata extracted to database");
  console.log(
    "[Advanced MCP Server] Services available:",
    Object.keys(services)
  );
}

/**
 * Handle MCP tool calls
 */
async function handleToolCall(toolName: string, args: any): Promise<any> {
  if (!globalAPIDB || !globalAPIExecutor) {
    throw new Error("Server not initialized");
  }

  switch (toolName) {
    case "c4_searchAPI": {
      const { query, searchType = "natural", limit = 10 } = args;

      if (searchType === "sql") {
        // Execute raw SQL query
        const results = globalAPIDB.executeSQL(query);
        return {
          content: [
            {
              type: "text",
              text: `SQL Query Results:\n\`\`\`json\n${JSON.stringify(results, null, 2)}\n\`\`\``,
            },
          ],
        };
      } else {
        // Natural language search
        const results = globalAPIDB.searchAPIs(query, limit);

        const formattedResults = results.map((api) => ({
          name: api.name,
          description: api.description,
          category: api.category,
          requiresAuth: !!api.requires_auth,
          httpPath: api.http_path,
        }));

        return {
          content: [
            {
              type: "text",
              text: `Found ${results.length} APIs matching "${query}":\n\n${formattedResults
                .map(
                  (api) =>
                    `**${api.name}** (${api.category})\n` +
                    `Description: ${api.description}\n` +
                    `Auth Required: ${api.requiresAuth ? "Yes" : "No"}\n` +
                    `HTTP Path: ${api.httpPath}\n`
                )
                .join("\n---\n")}`,
            },
          ],
        };
      }
    }

    case "c4_getAPIDetails": {
      const { apiName } = args;

      const details = globalAPIDB.getAPIDetails(apiName);
      if (!details) {
        throw new Error(`API not found: ${apiName}`);
      }

      const inputParams = details.parameters.filter(
        (p: any) => p.parameter_type === "input"
      );
      const outputParams = details.parameters.filter(
        (p: any) => p.parameter_type === "output"
      );

      // Get examples for this endpoint
      const examples = globalAPIDB.getAPIExamples(apiName);

      const formatParams = (params: any[]) => {
        if (params.length === 0) return "None";
        return params
          .map(
            (p) =>
              `- **${p.parameter_name}** (${p.data_type})${p.is_required ? " *required*" : " *optional*"}\n` +
              `  ${p.description || "No description available"}\n` +
              (p.example_value ? `  Example: \`${p.example_value}\`\n` : "")
          )
          .join("\n");
      };

      const formatExamples = (examples: any[]) => {
        if (examples.length === 0) return "No examples available.";

        // Group examples by type
        const inputExamples = examples.filter(
          (ex) => ex.example_type === "input"
        );
        const outputExamples = examples.filter(
          (ex) => ex.example_type === "output"
        );

        if (inputExamples.length === 0 && outputExamples.length === 0) {
          return "No examples available.";
        }

        let result = "";

        // Display input examples
        if (inputExamples.length > 0) {
          result += "### Input Examples\n\n";
          inputExamples.forEach((ex, index) => {
            result += `**${ex.title || `Input Example ${index + 1}`}**\n`;
            if (ex.description) result += `${ex.description}\n\n`;
            result += `\`\`\`json\n${ex.example_data || "{}"}\n\`\`\`\n\n`;
          });
        }

        // Display output examples
        if (outputExamples.length > 0) {
          result += "### Output Examples\n\n";
          outputExamples.forEach((ex, index) => {
            result += `**${ex.title || `Output Example ${index + 1}`}**\n`;
            if (ex.description) result += `${ex.description}\n\n`;
            result += `\`\`\`json\n${ex.example_data || "{}"}\n\`\`\`\n\n`;
          });
        }

        return result.trim();
      };

      return {
        content: [
          {
            type: "text",
            text:
              `# API Details: ${details.name}\n\n` +
              `**Category:** ${details.category}\n` +
              `**Description:** ${details.description}\n` +
              `**Authentication Required:** ${details.requires_auth ? "Yes" : "No"}\n` +
              `**HTTP Path:** ${details.http_path}\n\n` +
              `## Code Location\n` +
              `- **API Definition:** ${details.source_file_path || "N/A"}:${details.source_line_number || "N/A"}\n` +
              `- **Input Schema:** ${details.input_schema_file || "N/A"}:${details.input_schema_line || "N/A"}\n` +
              `- **Service Logic:** ${details.service_file_path || "N/A"}:${details.service_method_line || "N/A"}\n\n` +
              `## Input Parameters\n${formatParams(inputParams)}\n\n` +
              `## Output Parameters\n${formatParams(outputParams)}\n\n` +
              `## Examples\n${formatExamples(examples)}`,
          },
        ],
      };
    }

    case "c4_executeAPI": {
      const { apiName, input } = args;
      let { authToken } = args;

      // If no token is provided in the call, use the one from our session
      if (!authToken && mcpSession.authToken) {
        console.log(`[MCP Server] Using stored session token for ${apiName}`);
        authToken = mcpSession.authToken;
      }

      const result = await globalAPIExecutor.executeAPI(
        apiName,
        input,
        authToken
      );

      if (result.success) {
        return {
          content: [
            {
              type: "text",
              text:
                `✅ **API Call Successful: ${apiName}**\n\n` +
                `**Timestamp:** ${result.timestamp}\n\n` +
                `**Result:**\n\`\`\`json\n${JSON.stringify(result.data, null, 2)}\n\`\`\``,
            },
          ],
        };
      } else {
        return {
          content: [
            {
              type: "text",
              text:
                `❌ **API Call Failed: ${apiName}**\n\n` +
                `**Timestamp:** ${result.timestamp}\n\n` +
                `**Error:** ${result.error}`,
            },
          ],
        };
      }
    }

    case "c4_getDBSchema": {
      return {
        content: [
          {
            type: "text",
            text: `# API Metadata Database Schema\n\n${globalAPIDB.getSchema()}`,
          },
        ],
      };
    }

    case "c4_login": {
      const { email, password } = args;
      if (!globalAPIExecutor) throw new Error("Executor not initialized");

      console.log(`[MCP Server] Attempting login for ${email}`);
      const result = await globalAPIExecutor.executeAPI("auth.login", {
        email,
        password,
      });

      if (result.success && result.data.token) {
        // Store the token in our server-side session
        mcpSession.authToken = result.data.token;
        console.log(`[MCP Server] Login successful. Session token stored.`);
        return {
          content: [
            {
              type: "text",
              text: "✅ **Login successful!**\n\nYou are now authenticated and can execute protected API calls without providing a token manually. The session will be maintained until you call `c4_logout` or the server restarts.",
            },
          ],
        };
      } else {
        mcpSession.authToken = null; // Clear any old token
        console.error("[MCP Server] Login failed:", result.error);
        throw new Error(
          `Login failed: ${result.error || "Invalid credentials"}`
        );
      }
    }

    case "c4_logout": {
      console.log("[MCP Server] Logging out and clearing session token.");
      mcpSession.authToken = null;
      return {
        content: [
          {
            type: "text",
            text: "✅ **Logout successful!**\n\nYour session has been cleared. You will need to use `c4_login` again to access authenticated APIs.",
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

/**
 * Handle MCP requests
 */
async function handleMCPRequest(request: MCPRequest): Promise<MCPResponse> {
  const { method, params, id } = request;

  try {
    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: "c4-arch-advanced-mcp",
              version: "1.0.0",
            },
          },
        };

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: [
              {
                name: "c4_searchAPI",
                description:
                  'Search for API endpoints using natural language keywords (e.g., "create workspace", "workspace actor association") or a precise SQL query. For general discovery, use a "natural" search which leverages Full-Text Search for intelligent matching. For complex filtering, use a "sql" search against the database schema provided by c4_getDBSchema.',
                inputSchema: {
                  type: "object",
                  properties: {
                    query: {
                      type: "string",
                      description:
                        "Search query (natural language keywords for discovery) or SQL query for advanced filtering",
                    },
                    searchType: {
                      type: "string",
                      enum: ["natural", "sql"],
                      description:
                        'Type of search - "natural" for intelligent keyword matching using FTS, "sql" for direct SQL query',
                      default: "natural",
                    },
                    limit: {
                      type: "number",
                      description: "Maximum number of results to return",
                      default: 10,
                    },
                  },
                  required: ["query"],
                },
              },
              {
                name: "c4_getAPIDetails",
                description:
                  "Get comprehensive details for a specific API endpoint including all input/output parameters, descriptions, examples, and schema information.",
                inputSchema: {
                  type: "object",
                  properties: {
                    apiName: {
                      type: "string",
                      description:
                        'Full API name in format "domain.method" (e.g., "auth.register", "workspaces.create")',
                    },
                  },
                  required: ["apiName"],
                },
              },
              {
                name: "c4_executeAPI",
                description:
                  "Execute an API call directly. If the API requires authentication, you must use the `c4_login` tool first to establish a session. The server will automatically use your stored authentication token.",
                inputSchema: {
                  type: "object",
                  properties: {
                    apiName: {
                      type: "string",
                      description: 'Full API name in format "domain.method"',
                    },
                    input: {
                      type: "object",
                      description: "Input parameters for the API call",
                    },
                    authToken: {
                      type: "string",
                      description:
                        "Optional JWT token to override the session token (advanced usage only)",
                    },
                  },
                  required: ["apiName", "input"],
                },
              },
              {
                name: "c4_login",
                description:
                  "Authenticate with the system to establish a session for making authenticated API calls. The session token is managed automatically by the server and will be used for all subsequent API calls that require authentication.",
                inputSchema: {
                  type: "object",
                  properties: {
                    email: {
                      type: "string",
                      description: "User email address",
                    },
                    password: {
                      type: "string",
                      description: "User password",
                    },
                  },
                  required: ["email", "password"],
                },
              },
              {
                name: "c4_logout",
                description:
                  "End the current authenticated session and clear the stored authentication token. You will need to login again to access protected APIs.",
                inputSchema: {
                  type: "object",
                  properties: {},
                },
              },
              {
                name: "c4_getDBSchema",
                description:
                  "Get the database schema for the API metadata database. Use this to understand the structure and write SQL queries.",
                inputSchema: {
                  type: "object",
                  properties: {},
                },
              },
            ],
          },
        };

      case "tools/call": {
        const { name: toolName, arguments: toolArgs } = params;
        const result = await handleToolCall(toolName, toolArgs);

        return {
          jsonrpc: "2.0",
          id,
          result,
        };
      }

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Unknown method: ${method}`,
          },
        };
    }
  } catch (error: any) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: `Internal error: ${error.message}`,
      },
    };
  }
}

/**
 * Main function to start the server
 */
async function main() {
  try {
    console.log("[Advanced HTTP MCP Server] Starting up...");

    // Initialize API and database
    await initializeAPI();

    // Create Express app
    const app = express();

    // Middleware
    app.use(cors());
    app.use(express.json({ limit: "10mb" }));

    // Add request logging
    app.use((req: Request, _res: Response, next: NextFunction) => {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
      next();
    });

    // MCP endpoint
    app.post("/mcp", async (req: Request, res: Response) => {
      try {
        const mcpResponse = await handleMCPRequest(req.body);
        res.json(mcpResponse);
      } catch (error) {
        console.error("[Advanced HTTP MCP] Error handling MCP request:", error);
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
        });
      }
    });

    // Health check endpoint
    app.get("/health", (_req: Request, res: Response) => {
      res.json({
        status: "healthy",
        timestamp: new Date().toISOString(),
        server: "c4-arch-advanced-mcp",
        version: "1.0.0",
        protocol: "MCP 2024-11-05",
        features: [
          "Database-backed API discovery",
          "Intelligent search (natural language + SQL)",
          "Direct API execution",
          "Real-time schema access",
        ],
      });
    });

    // Tools list endpoint for debugging
    app.get("/mcp/tools", (_req: Request, res: Response) => {
      res.json({
        tools: [
          "c4_searchAPI - Search APIs by functionality or SQL query",
          "c4_getAPIDetails - Get comprehensive API documentation",
          "c4_executeAPI - Execute API calls directly",
          "c4_getDBSchema - Get database schema for custom queries",
        ],
      });
    });

    // Database info endpoint
    app.get("/mcp/database", (_req: Request, res: Response) => {
      if (!globalAPIDB) {
        res.status(500).json({ error: "Database not initialized" });
        return;
      }

      try {
        const endpoints = globalAPIDB.executeSQL(
          "SELECT COUNT(*) as count FROM api_endpoints"
        );
        const categories = globalAPIDB.executeSQL(`
          SELECT category, COUNT(*) as count 
          FROM api_endpoints 
          GROUP BY category 
          ORDER BY count DESC
        `);

        res.json({
          endpoints: endpoints[0],
          categories,
          database_path: API_DB_PATH,
        });
      } catch (error) {
        res.status(500).json({ error: "Database query failed" });
      }
    });

    // Start server
    const port = process.env["PORT"] || 3102;
    app.listen(port, () => {
      console.log(
        `[Advanced HTTP MCP Server] Server running on http://localhost:${port}`
      );
      console.log(
        `[Advanced HTTP MCP Server] MCP endpoint: http://localhost:${port}/mcp`
      );
      console.log(
        `[Advanced HTTP MCP Server] Health check: http://localhost:${port}/health`
      );
      console.log(
        `[Advanced HTTP MCP Server] Tools list: http://localhost:${port}/mcp/tools`
      );
      console.log(
        `[Advanced HTTP MCP Server] Database info: http://localhost:${port}/mcp/database`
      );
      console.log("[Advanced HTTP MCP Server] Ready to accept MCP connections");
    });
  } catch (error) {
    console.error("[Advanced HTTP MCP Server] Failed to start:", error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log(
    "[Advanced HTTP MCP Server] Received SIGINT, shutting down gracefully..."
  );
  if (globalFileWatcher) {
    globalFileWatcher.stop();
  }
  if (globalAPIDB) {
    globalAPIDB.close();
  }
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log(
    "[Advanced HTTP MCP Server] Received SIGTERM, shutting down gracefully..."
  );
  if (globalFileWatcher) {
    globalFileWatcher.stop();
  }
  if (globalAPIDB) {
    globalAPIDB.close();
  }
  process.exit(0);
});

// Start the server
main();
