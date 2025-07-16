/**
 * MCP Routes - Advanced MCP functionality integrated into Hono
 *
 * This module provides intelligent API discovery, documentation, and execution
 * through a searchable SQLite database integrated with the main Hono server.
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, unlinkSync } from "fs";
import { Hono } from "hono";
import { join } from "path";
import { type Services } from "../services";
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
          e.http_path,
          s.rank
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
      SELECT 
        parameter_name,
        parameter_type,
        data_type,
        is_required,
        description,
        array_element_type,
        referenced_schema,
        nested_path
      FROM api_parameters 
      WHERE endpoint_id = ? 
      ORDER BY parameter_type, nested_path, parameter_name
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
   * Get parameters for a given endpoint ID
   */
  _getEndpointParameters(endpointId: number): any[] {
    const parametersQuery = this.db.prepare(`
      SELECT 
        parameter_name as name, 
        data_type as dataType, 
        is_required as isRequired, 
        description,
        array_element_type as arrayElementType,
        referenced_schema as referencedSchema,
        nested_path as nestedPath
      FROM api_parameters
      WHERE endpoint_id = ? AND parameter_type = 'input'
      ORDER BY nested_path, parameter_name
    `);
    return parametersQuery.all(endpointId);
  }

  /**
   * Get output parameters for a given endpoint ID
   */
  _getEndpointOutputParameters(endpointId: number): any[] {
    const parametersQuery = this.db.prepare(`
      SELECT 
        parameter_name as name, 
        data_type as dataType, 
        is_required as isRequired, 
        description,
        array_element_type as arrayElementType,
        referenced_schema as referencedSchema,
        nested_path as nestedPath
      FROM api_parameters
      WHERE endpoint_id = ? AND parameter_type = 'output'
      ORDER BY nested_path, parameter_name
    `);
    return parametersQuery.all(endpointId);
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

  /**
   * Format data type with enhanced array information
   */
  formatDataType(
    dataType: string,
    arrayElementType: string | null,
    referencedSchema: string | null
  ): string {
    if (dataType === "array") {
      if (referencedSchema) {
        return `array<${referencedSchema}>`;
      } else if (arrayElementType) {
        return `array<${arrayElementType}>`;
      }
      return "array";
    }
    return dataType;
  }

  /**
   * Generate parameter description based on schema information
   */
  generateParameterDescription(param: any): string {
    if (param.referencedSchema) {
      return `Array of ${param.referencedSchema} objects`;
    }
    if (param.arrayElementType) {
      return `Array of ${param.arrayElementType} values`;
    }
    if (param.nestedPath && param.nestedPath.includes(".")) {
      return `Nested parameter: ${param.nestedPath}`;
    }
    return param.dataType || "No description available";
  }

  /**
   * Get properties of a referenced schema
   */
  getReferencedSchemaProperties(schemaName: string): any[] {
    // Look for parameters that belong to this schema by checking nested_path patterns
    const query = this.db.prepare(`
      SELECT DISTINCT 
        parameter_name,
        data_type,
        is_required,
        description,
        array_element_type,
        referenced_schema,
        nested_path
      FROM api_parameters 
      WHERE referenced_schema = ? 
      OR source_schema_name = ?
      OR nested_path LIKE '%.%'
      ORDER BY parameter_name
    `);

    const properties = query.all(schemaName, schemaName);

    // Filter to get only the direct properties of the schema
    const directProperties = properties.filter((p: any) => {
      // For nested paths like 'holes.distance', 'holes.hole', 'holes.putts'
      // we want to extract the property name after the dot
      if (p.nested_path && p.nested_path.includes(".")) {
        const parts = p.nested_path.split(".");
        return parts.length === 2; // Only direct nested properties
      }
      return p.source_schema_name === schemaName;
    });

    return directProperties.map((p: any) => ({
      name: p.parameter_name,
      dataType: this.formatDataType(
        p.data_type,
        p.array_element_type,
        p.referenced_schema
      ),
      isRequired: !!p.is_required,
      description: p.description || this.generateParameterDescription(p),
    }));
  }

  close(): void {
    this.db.close();
  }
}

/**
 * API Executor - Handles calls through Hono app instance
 */
class APIExecutor {
  private honoApp: any;

  constructor(honoApp: any, _services: any) {
    this.honoApp = honoApp;
  }

  /**
   * Execute an API call through Hono's app instance
   */
  async executeAPI(
    apiName: string,
    input: any,
    authToken?: string
  ): Promise<any> {
    const [domain, method] = apiName.split("/");

    if (!domain || !method) {
      throw new Error(
        `Invalid API name format: ${apiName}. Expected format: domain/method`
      );
    }

    try {
      // Construct the HTTP path
      const path = `/rpc/${domain}/${method}`;

      // Prepare headers
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (authToken) {
        headers["Authorization"] = `Bearer ${authToken}`;
      }

      // Create a mock request object for Hono
      const mockRequest = new Request(`http://localhost${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(input),
      });

      // Call the Hono app directly
      const response = await this.honoApp.fetch(mockRequest);
      const responseData = await response.json();

      if (!response.ok) {
        throw new Error(
          (responseData as any).error ||
            `HTTP ${response.status}: ${response.statusText}`
        );
      }

      return {
        success: true,
        data: responseData,
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
 * MCP Context - holds all MCP-related state
 */
class MCPContext {
  public apiDB!: APIDatabase;
  public apiExecutor: APIExecutor;
  public fileWatcher: APIFileWatcher;
  public session: { authToken: string | null } = { authToken: null };

  constructor(apiApp: any, services: Services) {
    this.apiExecutor = new APIExecutor(apiApp, services);
    this.fileWatcher = createDefaultWatcher(API_DB_PATH, () => apiApp);
  }

  async initialize(): Promise<void> {
    console.log("[MCP] Initializing API metadata extraction...");

    // Delete existing API metadata database to ensure fresh schema
    if (existsSync(API_DB_PATH)) {
      console.log(
        `[MCP] Removing existing API metadata database: ${API_DB_PATH}`
      );
      unlinkSync(API_DB_PATH);
    }

    // Create fresh database instance after file deletion
    this.apiDB = new APIDatabase(API_DB_PATH);

    // Extract comprehensive API metadata to database using dynamic extractor
    console.log("[MCP] Extracting comprehensive API metadata...");
    const apiFilePath = join(process.cwd(), "src/api/api.ts");
    const extractor = new SimpleAPIExtractor(
      API_DB_PATH,
      apiFilePath,
      process.cwd()
    );
    await extractor.extractFromAPI();
    extractor.close();

    // Setup file watcher for automatic updates
    console.log("[MCP] Setting up file watcher for automatic updates...");
    this.fileWatcher.start();

    console.log("[MCP] ✅ API metadata extraction completed");
  }

  close(): void {
    this.fileWatcher.stop();
    this.apiDB.close();
  }
}

/**
 * Handle MCP tool calls
 */
async function handleToolCall(
  toolName: string,
  args: any,
  mcpContext: MCPContext
): Promise<any> {
  switch (toolName) {
    case "c4_searchAPI": {
      const { query, searchType = "natural", limit = 10 } = args;

      if (searchType === "sql") {
        // Execute raw SQL query
        const results = mcpContext.apiDB.executeSQL(query);
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
        const results = mcpContext.apiDB.searchAPIs(query, limit);

        const formattedResults = results.map((api) => {
          const inputParameters = mcpContext.apiDB._getEndpointParameters(
            api.id
          );
          const outputParameters = mcpContext.apiDB._getEndpointOutputParameters(
            api.id
          );

          // Apply same filtering logic as in getAPIDetails to avoid duplication
          const paramsWithReferencedSchemas = inputParameters.filter(
            (p: any) => p.referencedSchema
          );
          const filteredInputParameters = inputParameters.filter((p: any) => {
            if (p.nestedPath && p.nestedPath.includes(".")) {
              const parentPath = p.nestedPath.split(".")[0];
              const parentHasReferencedSchema =
                paramsWithReferencedSchemas.some(
                  (parent: any) =>
                    parent.nestedPath === parentPath && parent.referencedSchema
                );
              if (parentHasReferencedSchema) {
                return false;
              }
            }
            return true;
          });

          // Apply same filtering logic for output parameters
          const outputParamsWithReferencedSchemas = outputParameters.filter(
            (p: any) => p.referencedSchema
          );
          const filteredOutputParameters = outputParameters.filter((p: any) => {
            if (p.nestedPath && p.nestedPath.includes(".")) {
              const parentPath = p.nestedPath.split(".")[0];
              const parentHasReferencedSchema =
                outputParamsWithReferencedSchemas.some(
                  (parent: any) =>
                    parent.nestedPath === parentPath && parent.referencedSchema
                );
              if (parentHasReferencedSchema) {
                return false;
              }
            }
            return true;
          });

          const confidenceScore = api.rank ? 1.0 - api.rank : 0.0; // Normalize rank to a 0-1 score

          // Generate example tool_code
          let exampleToolCode = `print(default_api.run_shell_command(command='''curl -X POST -H "Content-Type: application/json" -d '{\n  "jsonrpc": "2.0",\n  "id": "call-api-1",\n  "method": "tools/call",\n  "params": {\n    "name": "c4_executeAPI",\n    "arguments": {\n      "apiName": "${api.name}",\n      "input": {`;

          if (filteredInputParameters.length > 0) {
            const exampleInput: { [key: string]: any } = {};
            filteredInputParameters.forEach((param) => {
              // Provide a placeholder example value based on data type
              if (param.dataType === "string")
                exampleInput[param.name] = "example_string";
              else if (param.dataType === "number")
                exampleInput[param.name] = 123;
              else if (param.dataType === "boolean")
                exampleInput[param.name] = true;
              else exampleInput[param.name] = null; // Default for other types
            });
            exampleToolCode += `\n        ${JSON.stringify(exampleInput, null, 8).slice(1, -1).trim()}\n      `;
          }

          exampleToolCode += `}\n    }\n  }\n}' http://localhost:3102/mcp'''))`;

          return {
            apiName: api.name,
            description: api.description,
            category: api.category,
            requiresAuth: !!api.requires_auth,
            confidenceScore: parseFloat(confidenceScore.toFixed(2)),
            inputParameters: filteredInputParameters.map((p: any) => ({
              name: p.name,
              dataType: mcpContext.apiDB.formatDataType(
                p.dataType,
                p.arrayElementType,
                p.referencedSchema
              ),
              isRequired: !!p.isRequired,
              description:
                p.description ||
                mcpContext.apiDB.generateParameterDescription(p),
            })),
            outputParameters: filteredOutputParameters.map((p: any) => ({
              name: p.name,
              dataType: mcpContext.apiDB.formatDataType(
                p.dataType,
                p.arrayElementType,
                p.referencedSchema
              ),
              isRequired: !!p.isRequired,
              description:
                p.description ||
                mcpContext.apiDB.generateParameterDescription(p),
            })),
            example: {
              tool_code: exampleToolCode,
            },
          };
        });

        return {
          content: formattedResults,
        };
      }
    }

    case "c4_getAPIDetails": {
      const { apiName } = args;

      const details = mcpContext.apiDB.getAPIDetails(apiName);
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
      const examples = mcpContext.apiDB.getAPIExamples(apiName);

      // Format parameters with enhanced schema information
      const formatParametersStructured = (params: any[]) => {
        // First, identify parameters that have referenced schemas
        const paramsWithReferencedSchemas = params.filter(
          (p: any) => p.referenced_schema
        );

        // Filter out nested parameters that are already described in referenced schemas
        const filteredParams = params.filter((p: any) => {
          // If this parameter has a nested path with a dot, check if its parent has a referenced schema
          if (p.nested_path && p.nested_path.includes(".")) {
            const parentPath = p.nested_path.split(".")[0];
            // Check if any parameter with this parent path has a referenced schema
            const parentHasReferencedSchema = paramsWithReferencedSchemas.some(
              (parent: any) =>
                parent.nested_path === parentPath && parent.referenced_schema
            );
            // If parent has referenced schema, skip this nested parameter
            if (parentHasReferencedSchema) {
              return false;
            }
          }
          return true;
        });

        return filteredParams.map((p: any) => {
          const param: any = {
            name: p.parameter_name,
            dataType: mcpContext.apiDB.formatDataType(
              p.data_type,
              p.array_element_type,
              p.referenced_schema
            ),
            isRequired: !!p.is_required,
            description:
              p.description || mcpContext.apiDB.generateParameterDescription(p),
            nestedPath: p.nested_path || null,
          };

          // Add referenced schema details if available
          if (p.referenced_schema) {
            param.referencedSchema = {
              name: p.referenced_schema,
              properties: mcpContext.apiDB.getReferencedSchemaProperties(
                p.referenced_schema
              ),
            };
          }

          return param;
        });
      };

      const formatExamplesStructured = (examples: any[]) => {
        return examples.map((ex: any) => ({
          type: ex.example_type,
          title: ex.title,
          description: ex.description,
          data: ex.example_data ? JSON.parse(ex.example_data) : {},
        }));
      };

      return {
        content: {
          apiName: details.name,
          category: details.category,
          description: details.description,
          requiresAuth: !!details.requires_auth,
          httpPath: details.http_path,
          codeLocation: {
            apiDefinition: {
              file: details.source_file_path || null,
              line: details.source_line_number || null,
            },
            inputSchema: {
              file: details.input_schema_file || null,
              line: details.input_schema_line || null,
            },
            serviceLogic: {
              file: details.service_file_path || null,
              line: details.service_method_line || null,
            },
          },
          inputParameters: formatParametersStructured(inputParams),
          outputParameters: formatParametersStructured(outputParams),
          examples: formatExamplesStructured(examples),
        },
      };
    }

    case "c4_executeAPI": {
      const { apiName, input } = args;
      let { authToken } = args;

      // If no token is provided in the call, use the one from our session
      if (!authToken && mcpContext.session.authToken) {
        console.log(`[MCP Server] Using stored session token for ${apiName}`);
        authToken = mcpContext.session.authToken;
      }

      const result = await mcpContext.apiExecutor.executeAPI(
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
            text: `# API Metadata Database Schema\n\n${mcpContext.apiDB.getSchema()}`,
          },
        ],
      };
    }

    case "c4_login": {
      const { email, password } = args;
      console.log(`[MCP Server] Attempting login for ${email}`);
      const result = await mcpContext.apiExecutor.executeAPI("auth/login", {
        email,
        password,
      });

      if (result.success && result.data.token) {
        // Store the token in our server-side session
        mcpContext.session.authToken = result.data.token;
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
        mcpContext.session.authToken = null; // Clear any old token
        console.error("[MCP Server] Login failed:", result.error);
        throw new Error(
          `Login failed: ${result.error || "Invalid credentials"}`
        );
      }
    }

    case "c4_logout": {
      console.log("[MCP Server] Logging out and clearing session token.");
      mcpContext.session.authToken = null;
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
async function handleMCPRequest(
  request: MCPRequest,
  mcpContext: MCPContext
): Promise<MCPResponse> {
  const { method, params, id } = request;
  console.log(`[MCP Server] Handling request: ${method}`);
  console.log(`[MCP Server] Params: ${JSON.stringify(params, null, 2)}`);
  console.log(`[MCP Server] ID: ${id}`);
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
              name: "integrated-mcp",
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
                        'Full API name in format "domain/method" (e.g., "auth/register", "rounds/create")',
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
                      description: 'Full API name in format "domain/method"',
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
        const result = await handleToolCall(toolName, toolArgs, mcpContext);

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
 * Create MCP routes for integration with main Hono app
 */
export function createMCPRoutes(apiApp: Hono, services: Services) {
  const app = new Hono();

  // Lazy initialization of MCP context
  let mcpContext: MCPContext | null = null;

  const getMCPContext = async () => {
    if (!mcpContext) {
      mcpContext = new MCPContext(apiApp, services);
      await mcpContext.initialize();
    }
    return mcpContext;
  };

  // MCP endpoint
  app.post("/", async (c) => {
    try {
      const body = await c.req.json();
      const context = await getMCPContext();
      const mcpResponse = await handleMCPRequest(body, context);
      return c.json(mcpResponse);
    } catch (error) {
      console.error("[MCP] Error handling request:", error);
      return c.json(
        {
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
        },
        500
      );
    }
  });

  // Health check endpoint
  app.get("/health", (c) => {
    return c.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      server: "integrated-mcp",
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
  app.get("/tools", (c) => {
    return c.json({
      tools: [
        "c4_searchAPI - Search APIs by functionality or SQL query",
        "c4_getAPIDetails - Get comprehensive API documentation",
        "c4_executeAPI - Execute API calls directly",
        "c4_getDBSchema - Get database schema for custom queries",
      ],
    });
  });

  // Database info endpoint
  app.get("/database", async (c) => {
    try {
      const context = await getMCPContext();
      const endpoints = context.apiDB.executeSQL(
        "SELECT COUNT(*) as count FROM api_endpoints"
      );
      const categories = context.apiDB.executeSQL(`
        SELECT category, COUNT(*) as count 
        FROM api_endpoints 
        GROUP BY category 
        ORDER BY count DESC
      `);

      return c.json({
        endpoints: endpoints[0],
        categories,
        database_path: API_DB_PATH,
      });
    } catch (error) {
      console.error("[MCP] Database query error:", error);
      return c.json({ error: "Database query failed" }, 500);
    }
  });

  return app;
}
