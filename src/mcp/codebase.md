# advanced-mcp-server-http.ts

```ts
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
import { createApp } from "../api/orpc-api.js";
import { SimpleAPIExtractor } from "./dynamic-api-extractor.js";
import { createDefaultWatcher, APIFileWatcher } from "./file-watcher.js";

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
let globalRouter: any = null;
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
      return fallbackQuery.all(searchTerm, searchTerm, searchTerm, limit);
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
-- Find APIs related to both 'workspace' and 'actor':
--   SELECT name, description FROM api_endpoints
--   JOIN api_search ON api_endpoints.id = api_search.rowid
--   WHERE api_search MATCH 'workspace AND actor';
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
-- Search for workspace-related APIs:
--   SELECT * FROM api_endpoints WHERE name LIKE '%workspace%';
--
-- Get input parameters for an API:
--   SELECT * FROM api_parameters WHERE endpoint_id = (
--     SELECT id FROM api_endpoints WHERE name = 'workspaces.create'
--   ) AND parameter_type = 'input';
`;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * API Executor - Handles direct oRPC calls
 */
class APIExecutor {
  private router: any;

  constructor(router: any) {
    this.router = router;
  }

  /**
   * Execute an API call directly through oRPC
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

    if (!this.router[domain] || !this.router[domain][method]) {
      throw new Error(`API not found: ${apiName}`);
    }

    // Create context for the call
    const context = authToken ? { user: { id: "mcp-user" } } : {};

    try {
      // Get the handler from the router
      const handler = this.router[domain][method]["~orpc"].handler;

      if (!handler) {
        throw new Error(`Handler not found for ${apiName}`);
      }

      // Execute the handler
      const result = await handler({ input, context });

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

  // Create services and oRPC router
  const services = createServices(database);
  const { router } = createApp(services);
  globalRouter = router;

  // Initialize API database and executor
  globalAPIDB = new APIDatabase(API_DB_PATH);
  globalAPIExecutor = new APIExecutor(globalRouter);

  // Extract comprehensive API metadata to database using dynamic extractor
  console.log("[Advanced MCP Server] Extracting comprehensive API metadata...");
  const apiFilePath = join(process.cwd(), "src/api/orpc-api.ts");
  const extractor = new SimpleAPIExtractor(API_DB_PATH, apiFilePath, process.cwd());
  await extractor.extractFromAPI();
  extractor.close();

  // Setup file watcher for automatic updates
  console.log("[Advanced MCP Server] Setting up file watcher for automatic updates...");
  globalFileWatcher = createDefaultWatcher(API_DB_PATH, () => globalRouter);
  globalFileWatcher.start();

  console.log("[Advanced MCP Server] API metadata extracted to database");
  console.log(
    "[Advanced MCP Server] Router structure:",
    Object.keys(globalRouter)
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
    app.use((req: Request, res: Response, next: NextFunction) => {
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
    app.get("/health", (req: Request, res: Response) => {
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
    app.get("/mcp/tools", (req: Request, res: Response) => {
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
    app.get("/mcp/database", (req: Request, res: Response) => {
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

```

# api-metadata.sql

```sql
-- API Metadata Database Schema
-- This schema stores comprehensive API metadata for search and documentation

-- Main API endpoints table
CREATE TABLE IF NOT EXISTS api_endpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,           -- e.g., "auth.register"
    domain TEXT NOT NULL,                -- e.g., "auth" 
    method TEXT NOT NULL,                -- e.g., "register"
    description TEXT,                    -- Human-readable description
    http_path TEXT NOT NULL,             -- e.g., "/rpc/auth.register"
    requires_auth BOOLEAN DEFAULT 1,     -- Whether auth is required
    category TEXT,                       -- e.g., "Authentication"
    
    -- Source code location information
    source_file_path TEXT,               -- Path to API definition file
    source_line_number INTEGER,          -- Line number in API file
    input_schema_file TEXT,              -- Path to input schema file
    input_schema_line INTEGER,           -- Line number of input schema
    service_file_path TEXT,              -- Path to service implementation
    service_method_line INTEGER,         -- Line number of service method
    
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- API parameters table (input/output parameters)
CREATE TABLE IF NOT EXISTS api_parameters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint_id INTEGER NOT NULL,        -- Foreign key to api_endpoints
    parameter_name TEXT NOT NULL,        -- Parameter name
    parameter_type TEXT NOT NULL,        -- "input" or "output"
    data_type TEXT,                      -- "string", "number", "object", etc.
    is_required BOOLEAN DEFAULT 0,       -- Whether parameter is required
    is_optional BOOLEAN DEFAULT 1,       -- Whether parameter is optional
    description TEXT,                    -- Parameter description
    example_value TEXT,                  -- JSON example value
    enum_values TEXT,                    -- JSON array of enum values
    nested_path TEXT,                    -- For nested object properties
    zod_schema TEXT,                     -- JSON representation of Zod schema
    source_schema_name TEXT,             -- Name of source schema
    source_property_path TEXT,           -- Path within source schema
    
    FOREIGN KEY (endpoint_id) REFERENCES api_endpoints(id) ON DELETE CASCADE
);

-- API examples table (request/response examples)
CREATE TABLE IF NOT EXISTS api_examples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint_id INTEGER NOT NULL,        -- Foreign key to api_endpoints
    example_type TEXT NOT NULL,          -- "input" or "output"
    title TEXT,                         -- Example title
    description TEXT,                   -- Example description
    example_data TEXT,                  -- JSON example data
    
    FOREIGN KEY (endpoint_id) REFERENCES api_endpoints(id) ON DELETE CASCADE
);

-- API tags table (for enhanced search and categorization)
CREATE TABLE IF NOT EXISTS api_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint_id INTEGER NOT NULL,        -- Foreign key to api_endpoints
    tag TEXT NOT NULL,                  -- Tag value
    
    FOREIGN KEY (endpoint_id) REFERENCES api_endpoints(id) ON DELETE CASCADE
);

-- Full-Text Search virtual table
CREATE VIRTUAL TABLE IF NOT EXISTS api_search USING fts5(
    endpoint_id UNINDEXED,              -- Foreign key to api_endpoints.id
    name,                               -- Endpoint name
    description,                        -- Endpoint description
    category,                           -- Endpoint category
    parameters                          -- Searchable parameter text
);

-- Indexes for better performance
CREATE INDEX IF NOT EXISTS idx_api_endpoints_domain ON api_endpoints(domain);
CREATE INDEX IF NOT EXISTS idx_api_endpoints_method ON api_endpoints(method);
CREATE INDEX IF NOT EXISTS idx_api_endpoints_category ON api_endpoints(category);
CREATE INDEX IF NOT EXISTS idx_api_endpoints_requires_auth ON api_endpoints(requires_auth);

CREATE INDEX IF NOT EXISTS idx_api_parameters_endpoint_id ON api_parameters(endpoint_id);
CREATE INDEX IF NOT EXISTS idx_api_parameters_type ON api_parameters(parameter_type);
CREATE INDEX IF NOT EXISTS idx_api_parameters_name ON api_parameters(parameter_name);

CREATE INDEX IF NOT EXISTS idx_api_examples_endpoint_id ON api_examples(endpoint_id);
CREATE INDEX IF NOT EXISTS idx_api_examples_type ON api_examples(example_type);

CREATE INDEX IF NOT EXISTS idx_api_tags_endpoint_id ON api_tags(endpoint_id);
CREATE INDEX IF NOT EXISTS idx_api_tags_tag ON api_tags(tag);

-- Triggers to maintain updated_at timestamp
CREATE TRIGGER IF NOT EXISTS update_api_endpoints_timestamp 
    AFTER UPDATE ON api_endpoints
BEGIN
    UPDATE api_endpoints SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;
```

# dynamic-api-extractor.ts

```ts
/**
 * Dynamic API Extractor - True metaprogramming approach
 * 
 * Starting from orpc-api.ts, this extractor:
 * 1. Parses the API structure using TypeScript AST
 * 2. Follows import chains to find Zod schemas and services
 * 3. Analyzes service methods to extract return types
 * 4. Builds a complete API database dynamically
 */

import { parse, AST_NODE_TYPES } from '@typescript-eslint/typescript-estree';
import { Database } from 'bun:sqlite';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname, resolve, relative } from 'path';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

interface FileInfo {
  path: string;
  content: string;
  ast: any;
}

interface DiscoveredEndpoint {
  name: string;
  domain: string;
  method: string;
  description?: string;
  httpPath: string;
  requiresAuth: boolean;
  category: string;
  inputSchemaInfo?: SchemaInfo;
  outputSchemaInfo?: SchemaInfo;
  serviceInfo?: ServiceMethodInfo;
  sourceLocation: SourceLocation;
}

interface SchemaInfo {
  name: string;
  filePath: string;
  lineNumber: number;
  properties: Record<string, any>;
  zodSchema?: z.ZodTypeAny;
}

interface ServiceMethodInfo {
  name: string;
  filePath: string;
  lineNumber: number;
  returnType: string;
  parameters: Array<{
    name: string;
    type: string;
    optional: boolean;
  }>;
}

interface SourceLocation {
  filePath: string;
  lineNumber: number;
  columnNumber: number;
}

export class DynamicAPIExtractor {
  private db: Database;
  private projectRoot: string;
  private apiFilePath: string;
  private fileCache: Map<string, FileInfo> = new Map();
  private schemaRegistry: Map<string, SchemaInfo> = new Map();
  private serviceRegistry: Map<string, ServiceMethodInfo[]> = new Map();

  constructor(dbPath: string, apiFilePath: string, projectRoot: string = process.cwd()) {
    this.db = new Database(dbPath);
    this.apiFilePath = resolve(apiFilePath);
    this.projectRoot = projectRoot;
    this.initializeDatabase();
  }

  private initializeDatabase(): void {
    // Try multiple possible paths for the schema file
    const possiblePaths = [
      join(__dirname, 'api-metadata.sql'),
      join(process.cwd(), 'src/mcp/api-metadata.sql'),
      join(this.projectRoot, 'src/mcp/api-metadata.sql'),
    ];

    let schemaPath: string | null = null;
    for (const path of possiblePaths) {
      if (existsSync(path)) {
        schemaPath = path;
        break;
      }
    }

    if (schemaPath) {
      const schema = readFileSync(schemaPath, 'utf-8');
      this.db.exec(schema);
      console.log(`[Dynamic API Extractor] Database initialized with schema from: ${schemaPath}`);
    } else {
      console.warn('[Dynamic API Extractor] Database schema file not found, creating basic tables...');
      this.createBasicTables();
    }
  }

  private createBasicTables(): void {
    // Create basic table structure if schema file is not found
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_endpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        domain TEXT NOT NULL,
        method TEXT NOT NULL,
        description TEXT,
        http_path TEXT NOT NULL,
        requires_auth BOOLEAN DEFAULT 1,
        category TEXT,
        source_file_path TEXT,
        source_line_number INTEGER,
        input_schema_file TEXT,
        input_schema_line INTEGER,
        service_file_path TEXT,
        service_method_line INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS api_parameters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        endpoint_id INTEGER NOT NULL,
        parameter_name TEXT NOT NULL,
        parameter_type TEXT NOT NULL,
        data_type TEXT,
        is_required BOOLEAN DEFAULT 0,
        is_optional BOOLEAN DEFAULT 1,
        description TEXT,
        example_value TEXT,
        enum_values TEXT,
        nested_path TEXT,
        zod_schema TEXT,
        source_schema_name TEXT,
        source_property_path TEXT,
        FOREIGN KEY (endpoint_id) REFERENCES api_endpoints(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS api_examples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        endpoint_id INTEGER NOT NULL,
        example_type TEXT NOT NULL,
        title TEXT,
        description TEXT,
        example_data TEXT,
        FOREIGN KEY (endpoint_id) REFERENCES api_endpoints(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS api_tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        endpoint_id INTEGER NOT NULL,
        tag TEXT NOT NULL,
        FOREIGN KEY (endpoint_id) REFERENCES api_endpoints(id) ON DELETE CASCADE
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS api_search USING fts5(
        endpoint_id UNINDEXED,
        name,
        description,
        category,
        parameters
      );
    `);
  }

  /**
   * Main extraction method - starts from orpc-api.ts and discovers everything
   */
  public async extractFromAPI(): Promise<void> {
    console.log('[Dynamic API Extractor] Starting dynamic API extraction...');
    console.log(`[Dynamic API Extractor] Entry point: ${this.apiFilePath}`);

    try {
      // Clear existing data
      this.clearDatabase();

      // Step 1: Parse the main API file
      const apiFile = await this.parseFile(this.apiFilePath);
      
      // Step 2: Extract procedure definitions from createProcedures function
      const procedures = this.extractProceduresFromAST(apiFile.ast);
      console.log(`[Dynamic API Extractor] Found ${Object.keys(procedures).length} domains`);

      // Step 3: Discover all schemas and services referenced in the API
      await this.discoverSchemasAndServices(apiFile);

      // Step 4: Process each endpoint
      const endpoints: DiscoveredEndpoint[] = [];
      for (const [domain, methods] of Object.entries(procedures)) {
        for (const [method, procedureInfo] of Object.entries(methods as any)) {
          const endpoint = await this.processEndpoint(domain, method, procedureInfo, apiFile);
          if (endpoint) {
            endpoints.push(endpoint);
          }
        }
      }

      // Step 5: Insert all endpoints into database
      for (const endpoint of endpoints) {
        await this.insertEndpoint(endpoint);
      }

      console.log(`[Dynamic API Extractor] ✅ Extracted ${endpoints.length} endpoints`);
      this.populateFTSIndex();

    } catch (error) {
      console.error('[Dynamic API Extractor] Error during extraction:', error);
      throw error;
    }
  }

  /**
   * Parse a TypeScript file and cache the result
   */
  private async parseFile(filePath: string): Promise<FileInfo> {
    const normalizedPath = resolve(filePath);
    
    if (this.fileCache.has(normalizedPath)) {
      return this.fileCache.get(normalizedPath)!;
    }

    if (!existsSync(normalizedPath)) {
      throw new Error(`File not found: ${normalizedPath}`);
    }

    const content = readFileSync(normalizedPath, 'utf-8');
    const ast = parse(content, {
      loc: true,
      range: true,
      comments: true,
      tokens: true,
    });

    const fileInfo: FileInfo = { path: normalizedPath, content, ast };
    this.fileCache.set(normalizedPath, fileInfo);
    
    console.log(`[Dynamic API Extractor] Parsed: ${relative(this.projectRoot, normalizedPath)}`);
    return fileInfo;
  }

  /**
   * Extract procedure definitions from the createProcedures function
   */
  private extractProceduresFromAST(ast: any): Record<string, Record<string, any>> {
    const procedures: Record<string, Record<string, any>> = {};

    // Find the createProcedures function
    const createProceduresFunction = this.findFunctionDeclaration(ast, 'createProcedures');
    if (!createProceduresFunction) {
      throw new Error('Could not find createProcedures function');
    }

    // Extract the return statement object
    const returnStatement = this.findReturnStatement(createProceduresFunction);
    if (!returnStatement || returnStatement.argument?.type !== AST_NODE_TYPES.ObjectExpression) {
      throw new Error('Could not find procedures object in createProcedures return statement');
    }

    // Parse the object structure
    for (const property of returnStatement.argument.properties) {
      if (property.type === AST_NODE_TYPES.Property && 
          property.key.type === AST_NODE_TYPES.Identifier) {
        const domain = property.key.name;
        
        if (property.value.type === AST_NODE_TYPES.ObjectExpression) {
          procedures[domain] = {};
          
          for (const methodProperty of property.value.properties) {
            if (methodProperty.type === AST_NODE_TYPES.Property && 
                methodProperty.key.type === AST_NODE_TYPES.Identifier) {
              const method = methodProperty.key.name;
              procedures[domain][method] = {
                node: methodProperty,
                location: {
                  filePath: this.apiFilePath,
                  lineNumber: methodProperty.loc?.start.line || 0,
                  columnNumber: methodProperty.loc?.start.column || 0,
                }
              };
            }
          }
        }
      }
    }

    return procedures;
  }

  /**
   * Discover all schemas and services by analyzing imports
   */
  private async discoverSchemasAndServices(apiFile: FileInfo): Promise<void> {
    console.log('[Dynamic API Extractor] Discovering schemas and services...');

    // Find all import statements
    const imports = this.extractImports(apiFile.ast);
    
    for (const importInfo of imports) {
      const importPath = this.resolveImportPath(importInfo.source, this.apiFilePath);
      
      if (importPath && existsSync(importPath)) {
        try {
          const importedFile = await this.parseFile(importPath);
          
          // Check if this is a schema file
          if (importPath.includes('/schemas/') || importInfo.source.includes('schemas')) {
            await this.discoverSchemasInFile(importedFile);
          }
          
          // Check if this is a service file
          if (importPath.includes('/services/') || importInfo.source.includes('services')) {
            await this.discoverServicesInFile(importedFile);
          }
        } catch (error) {
          console.warn(`[Dynamic API Extractor] Failed to parse import: ${importPath}`, error);
        }
      }
    }

    // Also discover by scanning directories
    await this.scanDirectoryForSchemas(join(this.projectRoot, 'src/api/schemas'));
    await this.scanDirectoryForServices(join(this.projectRoot, 'src/services'));
  }

  /**
   * Scan a directory for schema files
   */
  private async scanDirectoryForSchemas(dirPath: string): Promise<void> {
    if (!existsSync(dirPath)) return;

    const files = readdirSync(dirPath);
    for (const file of files) {
      const filePath = join(dirPath, file);
      const stat = statSync(filePath);
      
      if (stat.isFile() && file.endsWith('.ts') && !file.endsWith('.test.ts')) {
        try {
          const fileInfo = await this.parseFile(filePath);
          await this.discoverSchemasInFile(fileInfo);
        } catch (error) {
          console.warn(`[Dynamic API Extractor] Failed to parse schema file: ${filePath}`, error);
        }
      }
    }
  }

  /**
   * Scan a directory for service files
   */
  private async scanDirectoryForServices(dirPath: string): Promise<void> {
    if (!existsSync(dirPath)) return;

    const files = readdirSync(dirPath);
    for (const file of files) {
      const filePath = join(dirPath, file);
      const stat = statSync(filePath);
      
      if (stat.isFile() && file.endsWith('.service.ts')) {
        try {
          const fileInfo = await this.parseFile(filePath);
          await this.discoverServicesInFile(fileInfo);
        } catch (error) {
          console.warn(`[Dynamic API Extractor] Failed to parse service file: ${filePath}`, error);
        }
      }
    }
  }

  /**
   * Discover schema definitions in a file
   */
  private async discoverSchemasInFile(fileInfo: FileInfo): Promise<void> {
    const exports = this.findExportDeclarations(fileInfo.ast);
    
    for (const exportDecl of exports) {
      if (exportDecl.type === AST_NODE_TYPES.ExportNamedDeclaration && 
          exportDecl.declaration?.type === AST_NODE_TYPES.VariableDeclaration) {
        
        for (const declarator of exportDecl.declaration.declarations) {
          if (declarator.id.type === AST_NODE_TYPES.Identifier &&
              declarator.id.name.endsWith('Schema')) {
            
            const schemaName = declarator.id.name;
            const schemaInfo: SchemaInfo = {
              name: schemaName,
              filePath: fileInfo.path,
              lineNumber: declarator.loc?.start.line || 0,
              properties: {}, // Will be filled by analyzing the Zod schema
            };

            this.schemaRegistry.set(schemaName, schemaInfo);
            console.log(`[Dynamic API Extractor] Found schema: ${schemaName} in ${relative(this.projectRoot, fileInfo.path)}`);
          }
        }
      }
    }
  }

  /**
   * Discover service methods in a file
   */
  private async discoverServicesInFile(fileInfo: FileInfo): Promise<void> {
    const serviceClassName = this.extractServiceClassName(fileInfo.path);
    const serviceMethods: ServiceMethodInfo[] = [];
    
    const classDeclarations = this.findClassDeclarations(fileInfo.ast);
    
    for (const classDecl of classDeclarations) {
      if (classDecl.id?.name.includes('Service')) {
        const methods = this.extractMethodsFromClass(classDecl, fileInfo.path);
        serviceMethods.push(...methods);
      }
    }

    if (serviceMethods.length > 0) {
      this.serviceRegistry.set(serviceClassName, serviceMethods);
      console.log(`[Dynamic API Extractor] Found ${serviceMethods.length} methods in ${serviceClassName}`);
    }
  }

  /**
   * Process a single endpoint and gather all its metadata
   */
  private async processEndpoint(
    domain: string, 
    method: string, 
    procedureInfo: any, 
    apiFile: FileInfo
  ): Promise<DiscoveredEndpoint | null> {
    
    const endpoint: DiscoveredEndpoint = {
      name: `${domain}.${method}`,
      domain,
      method,
      description: this.generateDescription(domain, method),
      httpPath: `/rpc/${domain}.${method}`,
      requiresAuth: this.inferAuthRequirement(domain, method),
      category: this.inferCategory(domain),
      sourceLocation: procedureInfo.location,
    };

    // Find input schema from the procedure definition
    const inputSchemaName = this.extractInputSchemaFromProcedure(procedureInfo.node);
    if (inputSchemaName && this.schemaRegistry.has(inputSchemaName)) {
      endpoint.inputSchemaInfo = this.schemaRegistry.get(inputSchemaName);
    }

    // Find service method information
    const serviceKey = this.getServiceKey(domain);
    if (this.serviceRegistry.has(serviceKey)) {
      const serviceMethods = this.serviceRegistry.get(serviceKey)!;
      const serviceMethod = serviceMethods.find(m => m.name === method);
      if (serviceMethod) {
        endpoint.serviceInfo = serviceMethod;
        endpoint.outputSchemaInfo = this.inferOutputSchemaFromReturnType(serviceMethod.returnType);
      }
    }

    return endpoint;
  }

  /**
   * Helper functions for AST traversal
   */
  private findFunctionDeclaration(ast: any, functionName: string): any {
    const body = ast.body || [];
    for (const node of body) {
      if (node.type === AST_NODE_TYPES.FunctionDeclaration && 
          node.id?.name === functionName) {
        return node;
      }
    }
    return null;
  }

  private findReturnStatement(functionNode: any): any {
    if (!functionNode.body?.body) return null;
    
    for (const statement of functionNode.body.body) {
      if (statement.type === AST_NODE_TYPES.ReturnStatement) {
        return statement;
      }
    }
    return null;
  }

  private extractImports(ast: any): Array<{source: string, specifiers: string[]}> {
    const imports: Array<{source: string, specifiers: string[]}> = [];
    const body = ast.body || [];
    
    for (const node of body) {
      if (node.type === AST_NODE_TYPES.ImportDeclaration) {
        const source = node.source.value;
        const specifiers: string[] = [];
        
        for (const specifier of node.specifiers) {
          if (specifier.type === AST_NODE_TYPES.ImportSpecifier) {
            specifiers.push(specifier.imported.name);
          }
        }
        
        imports.push({ source, specifiers });
      }
    }
    
    return imports;
  }

  private resolveImportPath(importSource: string, fromFile: string): string | null {
    const basePath = dirname(fromFile);
    
    // Handle relative imports
    if (importSource.startsWith('.')) {
      const resolved = resolve(basePath, importSource);
      
      // Try different extensions
      for (const ext of ['.ts', '.js', '/index.ts', '/index.js']) {
        const fullPath = resolved + ext;
        if (existsSync(fullPath)) {
          return fullPath;
        }
      }
    }
    
    return null;
  }

  private findExportDeclarations(ast: any): any[] {
    const exports: any[] = [];
    const body = ast.body || [];
    
    for (const node of body) {
      if (node.type === AST_NODE_TYPES.ExportNamedDeclaration ||
          node.type === AST_NODE_TYPES.ExportDefaultDeclaration) {
        exports.push(node);
      }
    }
    
    return exports;
  }

  private findClassDeclarations(ast: any): any[] {
    const classes: any[] = [];
    const body = ast.body || [];
    
    for (const node of body) {
      if (node.type === AST_NODE_TYPES.ClassDeclaration) {
        classes.push(node);
      }
    }
    
    return classes;
  }

  private extractMethodsFromClass(classNode: any, filePath: string): ServiceMethodInfo[] {
    const methods: ServiceMethodInfo[] = [];
    
    if (!classNode.body?.body) return methods;
    
    for (const member of classNode.body.body) {
      if (member.type === AST_NODE_TYPES.MethodDefinition && 
          member.key.type === AST_NODE_TYPES.Identifier &&
          member.value.async) {
        
        const methodInfo: ServiceMethodInfo = {
          name: member.key.name,
          filePath,
          lineNumber: member.loc?.start.line || 0,
          returnType: this.extractReturnTypeFromMethod(member),
          parameters: this.extractParametersFromMethod(member),
        };
        
        methods.push(methodInfo);
      }
    }
    
    return methods;
  }

  private extractReturnTypeFromMethod(methodNode: any): string {
    // Try to extract from TypeScript type annotation
    if (methodNode.value.returnType?.typeAnnotation) {
      return this.typeAnnotationToString(methodNode.value.returnType.typeAnnotation);
    }
    
    // Fallback to inference from method name
    return this.inferReturnTypeFromMethodName(methodNode.key.name);
  }

  private extractParametersFromMethod(methodNode: any): Array<{name: string, type: string, optional: boolean}> {
    const parameters: Array<{name: string, type: string, optional: boolean}> = [];
    
    if (!methodNode.value.params) return parameters;
    
    for (const param of methodNode.value.params) {
      if (param.type === AST_NODE_TYPES.Identifier) {
        parameters.push({
          name: param.name,
          type: param.typeAnnotation ? this.typeAnnotationToString(param.typeAnnotation.typeAnnotation) : 'any',
          optional: param.optional || false,
        });
      }
    }
    
    return parameters;
  }

  private extractInputSchemaFromProcedure(procedureNode: any): string | null {
    // Look for os.input(SomeSchema) pattern
    if (procedureNode.value?.type === AST_NODE_TYPES.CallExpression) {
      const callee = procedureNode.value.callee;
      if (callee?.type === AST_NODE_TYPES.MemberExpression &&
          callee.property?.name === 'handler') {
        
        const object = callee.object;
        if (object?.type === AST_NODE_TYPES.CallExpression &&
            object.callee?.property?.name === 'input') {
          
          const schemaArg = object.arguments[0];
          if (schemaArg?.type === AST_NODE_TYPES.Identifier) {
            return schemaArg.name;
          }
        }
      }
    }
    
    return null;
  }

  /**
   * Utility methods
   */
  private extractServiceClassName(filePath: string): string {
    const filename = filePath.split('/').pop() || '';
    return filename.replace('.service.ts', '');
  }

  private getServiceKey(domain: string): string {
    // Map domain names to service file names
    const domainToService: Record<string, string> = {
      auth: 'auth',
      tests: 'test-templates',
      rounds: 'rounds',
      user: 'user',
    };
    
    return domainToService[domain] || domain;
  }

  private typeAnnotationToString(typeNode: any): string {
    if (!typeNode) return 'unknown';
    
    switch (typeNode.type) {
      case AST_NODE_TYPES.TSStringKeyword:
        return 'string';
      case AST_NODE_TYPES.TSNumberKeyword:
        return 'number';
      case AST_NODE_TYPES.TSBooleanKeyword:
        return 'boolean';
      case AST_NODE_TYPES.TSTypeReference:
        return typeNode.typeName?.name || 'unknown';
      default:
        return 'unknown';
    }
  }

  private inferReturnTypeFromMethodName(methodName: string): string {
    const typeMap: Record<string, string> = {
      create: 'CreatedEntity',
      update: 'UpdatedEntity',
      get: 'Entity',
      list: 'Entity[]',
      delete: '{ success: boolean }',
      login: 'AuthResponse',
      register: 'AuthResponse',
    };
    
    return typeMap[methodName] || 'unknown';
  }

  private generateDescription(domain: string, method: string): string {
    const methodDescriptions: Record<string, string> = {
      create: 'Create a new',
      get: 'Retrieve details for a specific',
      update: 'Update properties of an existing',
      delete: 'Delete an existing',
      list: 'List all',
      login: 'Authenticate user and create session',
      register: 'Register a new user account',
    };

    const domainNames: Record<string, string> = {
      auth: 'authentication',
      tests: 'test template',
      rounds: 'round',
      user: 'user profile',
    };

    const methodDesc = methodDescriptions[method] || `Perform ${method} operation on`;
    const domainName = domainNames[domain] || domain;

    return `${methodDesc} ${domainName}`;
  }

  private inferCategory(domain: string): string {
    const categoryMap: Record<string, string> = {
      auth: 'Authentication',
      tests: 'Test Management',
      rounds: 'Round Management',
      user: 'User Management',
    };

    return categoryMap[domain] || 'Other';
  }

  private inferAuthRequirement(domain: string, method: string): boolean {
    if (domain === 'auth' && ['login', 'register'].includes(method)) {
      return false;
    }
    if (domain === 'tests' && method === 'list') {
      return false;
    }
    if (domain === 'tests' && method === 'create') {
      return false;
    }
    return true;
  }

  private inferOutputSchemaFromReturnType(returnType: string): SchemaInfo | undefined {
    // For now, return undefined - could be enhanced to create synthetic schemas
    return undefined;
  }

  /**
   * Database operations
   */
  private clearDatabase(): void {
    try {
      // Clear tables in reverse dependency order, ignoring errors if tables don't exist
      const tables = ['api_search', 'api_tags', 'api_examples', 'api_parameters', 'api_endpoints'];
      
      for (const table of tables) {
        try {
          this.db.exec(`DELETE FROM ${table}`);
        } catch (error) {
          // Ignore table not found errors - tables might not exist yet
          if (!(error as any).message?.includes('no such table')) {
            console.warn(`[Dynamic API Extractor] Warning clearing table ${table}:`, error);
          }
        }
      }
    } catch (error) {
      console.warn('[Dynamic API Extractor] Warning during database clear:', error);
    }
  }

  private async insertEndpoint(endpoint: DiscoveredEndpoint): Promise<void> {
    const insertEndpoint = this.db.prepare(`
      INSERT INTO api_endpoints (
        name, domain, method, description, http_path, 
        requires_auth, category,
        source_file_path, source_line_number,
        input_schema_file, input_schema_line,
        service_file_path, service_method_line
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = insertEndpoint.run(
      endpoint.name,
      endpoint.domain,
      endpoint.method,
      endpoint.description || '',
      endpoint.httpPath,
      endpoint.requiresAuth ? 1 : 0,
      endpoint.category,
      endpoint.sourceLocation.filePath,
      endpoint.sourceLocation.lineNumber,
      endpoint.inputSchemaInfo?.filePath || '',
      endpoint.inputSchemaInfo?.lineNumber || 0,
      endpoint.serviceInfo?.filePath || '',
      endpoint.serviceInfo?.lineNumber || 0
    );

    const endpointId = result.lastInsertRowid as number;

    // Insert parameters if we have schema info
    if (endpoint.inputSchemaInfo) {
      await this.insertParametersFromSchemaInfo(endpointId, 'input', endpoint.inputSchemaInfo);
    }

    if (endpoint.serviceInfo) {
      await this.insertParametersFromServiceInfo(endpointId, 'output', endpoint.serviceInfo);
    }

    // Insert basic example
    await this.insertBasicExample(endpointId, endpoint.domain, endpoint.method);

    console.log(`[Dynamic API Extractor] Inserted endpoint: ${endpoint.name}`);
  }

  private async insertParametersFromSchemaInfo(
    endpointId: number, 
    type: 'input' | 'output', 
    schemaInfo: SchemaInfo
  ): Promise<void> {
    // For now, insert a placeholder - could be enhanced to load and parse actual Zod schemas
    const insertParam = this.db.prepare(`
      INSERT INTO api_parameters (
        endpoint_id, parameter_name, parameter_type, data_type,
        is_required, is_optional, description, source_schema_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertParam.run(
      endpointId,
      'schema_defined',
      type,
      'object',
      1,
      0,
      `Parameters defined in ${schemaInfo.name}`,
      schemaInfo.name
    );
  }

  private async insertParametersFromServiceInfo(
    endpointId: number,
    type: 'input' | 'output',
    serviceInfo: ServiceMethodInfo
  ): Promise<void> {
    // Insert service method parameters
    for (const param of serviceInfo.parameters) {
      const insertParam = this.db.prepare(`
        INSERT INTO api_parameters (
          endpoint_id, parameter_name, parameter_type, data_type,
          is_required, is_optional, description
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      insertParam.run(
        endpointId,
        param.name,
        'input', // Service method parameters are inputs
        param.type,
        param.optional ? 0 : 1,
        param.optional ? 1 : 0,
        `Service method parameter: ${param.name}`
      );
    }

    // Insert return type as output parameter
    if (serviceInfo.returnType && serviceInfo.returnType !== 'unknown') {
      const insertParam = this.db.prepare(`
        INSERT INTO api_parameters (
          endpoint_id, parameter_name, parameter_type, data_type,
          is_required, is_optional, description
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      insertParam.run(
        endpointId,
        'returnValue',
        'output',
        serviceInfo.returnType,
        1,
        0,
        `Return type: ${serviceInfo.returnType}`
      );
    }
  }

  private async insertBasicExample(endpointId: number, domain: string, method: string): Promise<void> {
    const inputExample = this.generateInputExample(domain, method);
    const outputExample = this.generateOutputExample(domain, method);

    // Insert input example
    const insertInputExample = this.db.prepare(`
      INSERT INTO api_examples (
        endpoint_id, example_type, title, description, example_data
      ) VALUES (?, ?, ?, ?, ?)
    `);

    insertInputExample.run(
      endpointId,
      'input',
      `${method} input example`,
      `Example input for ${domain}.${method}`,
      JSON.stringify(inputExample, null, 2)
    );

    // Insert output example
    const insertOutputExample = this.db.prepare(`
      INSERT INTO api_examples (
        endpoint_id, example_type, title, description, example_data
      ) VALUES (?, ?, ?, ?, ?)
    `);

    insertOutputExample.run(
      endpointId,
      'output',
      `${method} output example`,
      `Example output for ${domain}.${method}`,
      JSON.stringify(outputExample, null, 2)
    );
  }

  private generateInputExample(domain: string, method: string): any {
    // Generate domain-specific examples
    if (domain === 'auth') {
      if (method === 'register') {
        return {
          email: 'user@example.com',
          password: 'Password123!',
          firstName: 'John',
          lastName: 'Doe'
        };
      }
      if (method === 'login') {
        return {
          email: 'user@example.com',
          password: 'Password123!'
        };
      }
    }

    if (domain === 'tests') {
      if (method === 'create') {
        return {
          testId: 'custom-test',
          name: 'Custom Test',
          description: 'A custom putting test',
          holeCount: 3,
          distances: [1.0, 2.5, 4.0]
        };
      }
    }

    if (domain === 'rounds') {
      if (method === 'create') {
        return {
          testId: 'putting-9',
          testName: '9-Hole Putting Test',
          date: new Date().toISOString(),
          holes: [
            { hole: 1, distance: 1.5, putts: 2 }
          ]
        };
      }
    }

    return {};
  }

  private generateOutputExample(domain: string, method: string): any {
    if (domain === 'auth' && ['login', 'register'].includes(method)) {
      return {
        token: 'jwt-token-here',
        user: {
          id: 'user-123',
          email: 'user@example.com',
          firstName: 'John',
          lastName: 'Doe'
        }
      };
    }

    if (['create', 'update', 'delete'].includes(method)) {
      return { success: true };
    }

    if (method === 'list') {
      return { items: [], total: 0 };
    }

    return { success: true };
  }

  private populateFTSIndex(): void {
    console.log('[Dynamic API Extractor] Populating FTS index...');

    try {
      this.db.exec('DELETE FROM api_search');

      const endpointsQuery = this.db.prepare(`
        SELECT
          e.id,
          e.name,
          e.description,
          e.category,
          GROUP_CONCAT(p.parameter_name || ' ' || COALESCE(p.description, ''), ' ') as parameters
        FROM api_endpoints e
        LEFT JOIN api_parameters p ON e.id = p.endpoint_id
        GROUP BY e.id
      `);

      const endpoints = endpointsQuery.all();

      const insertFTS = this.db.prepare(`
        INSERT INTO api_search (endpoint_id, name, description, category, parameters)
        VALUES (?, ?, ?, ?, ?)
      `);

      for (const endpoint of endpoints as any[]) {
        insertFTS.run(
          endpoint.id,
          endpoint.name || '',
          endpoint.description || '',
          endpoint.category || '',
          endpoint.parameters || ''
        );
      }

      console.log(`[Dynamic API Extractor] ✅ FTS index populated with ${endpoints.length} entries`);
    } catch (error) {
      console.error('[Dynamic API Extractor] Error populating FTS index:', error);
    }
  }

  public close(): void {
    this.db.close();
  }
}

// Export for use in the MCP server
export { DynamicAPIExtractor as SimpleAPIExtractor };
```

# file-watcher.ts

```ts
/**
 * File Watcher for API Code Changes
 *
 * Monitors the API code files and automatically rebuilds the database
 * when changes are detected.
 */

import { watch } from 'fs';
import { join } from 'path';
import { SimpleAPIExtractor } from './dynamic-api-extractor.js';

// Type declarations for Node.js globals
declare const setTimeout: (callback: () => void, ms: number) => any;
declare const clearTimeout: (id: any) => void;

// We'll create a router by importing the necessary services
// This is a simplified approach that doesn't require exposing createProcedures

export interface WatcherConfig {
  apiDbPath: string;
  watchPaths: string[];
  debounceMs: number;
  onRebuild?: () => Promise<void>;
}

export class APIFileWatcher {
  private config: WatcherConfig;
  private debounceTimer: any = null;
  private watchers: any[] = [];
  private createRouter: () => any;

  constructor(config: WatcherConfig, createRouter: () => any) {
    this.config = config;
    this.createRouter = createRouter;
  }

  /**
   * Start watching for file changes
   */
  start(): void {
    console.log('[API File Watcher] Starting file watcher...');
    console.log(
      `[API File Watcher] Watching paths: ${this.config.watchPaths.join(', ')}`
    );

    for (const watchPath of this.config.watchPaths) {
      try {
        const watcher = watch(
          watchPath,
          { recursive: true },
          (eventType, filename) => {
            if (filename && this.shouldProcessFile(filename)) {
              console.log(
                `[API File Watcher] Detected ${eventType} in ${filename}`
              );
              this.debouncedRebuild();
            }
          }
        );

        this.watchers.push(watcher);
      } catch (error) {
        console.warn(`[API File Watcher] Could not watch ${watchPath}:`, error);
      }
    }

    // Initial build
    this.rebuildDatabase();
  }

  /**
   * Stop watching for file changes
   */
  stop(): void {
    console.log('[API File Watcher] Stopping file watcher...');

    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch (error) {
        console.warn('[API File Watcher] Error closing watcher:', error);
      }
    }
    this.watchers = [];

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /**
   * Check if file should trigger a rebuild
   */
  private shouldProcessFile(filename: string): boolean {
    // Only process TypeScript files in relevant directories
    if (!filename.endsWith('.ts')) return false;

    // Skip test files and generated files
    if (filename.includes('.test.') || filename.includes('.spec.'))
      return false;
    if (filename.includes('.gen.') || filename.includes('.generated.'))
      return false;

    // Process API, schema, and service files
    return (
      filename.includes('api') ||
      filename.includes('schema') ||
      filename.includes('service') ||
      filename.includes('orpc')
    );
  }

  /**
   * Debounced rebuild to avoid rebuilding on every file change
   */
  private debouncedRebuild(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.rebuildDatabase();
    }, this.config.debounceMs);
  }

  /**
   * Rebuild the API database
   */
  private async rebuildDatabase(): Promise<void> {
    try {
      console.log('[API File Watcher] Rebuilding API database...');

      // Extract API metadata to database using dynamic approach
      const apiFilePath = join(process.cwd(), "src/api/orpc-api.ts");
      const extractor = new SimpleAPIExtractor(this.config.apiDbPath, apiFilePath, process.cwd());
      await extractor.extractFromAPI();
      extractor.close();

      // Call custom rebuild callback if provided
      if (this.config.onRebuild) {
        await this.config.onRebuild();
      }

      console.log('[API File Watcher] ✅ API database rebuilt successfully');
    } catch (error) {
      console.error('[API File Watcher] ❌ Error rebuilding database:', error);
    }
  }
}

/**
 * Create a default file watcher for the project
 */
export function createDefaultWatcher(
  apiDbPath: string,
  createRouter: () => any
): APIFileWatcher {
  const config: WatcherConfig = {
    apiDbPath,
    watchPaths: [
      join(process.cwd(), 'src/api'),
      join(process.cwd(), 'src/services'),
      join(process.cwd(), 'src/api/schemas'),
    ],
    debounceMs: 2000, // 2 second debounce
  };

  return new APIFileWatcher(config, createRouter);
}

```

