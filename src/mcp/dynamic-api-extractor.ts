/**
 * Dynamic API Extractor - Hono + Zod API analysis
 *
 * Starting from api.ts, this extractor:
 * 1. Parses the Hono API structure using TypeScript AST
 * 2. Follows import chains to find Zod schemas and services
 * 3. Analyzes service methods to extract return types
 * 4. Builds a complete API database dynamically
 * 5. Handles auth middleware detection for Bearer token auth
 */

import { AST_NODE_TYPES, parse } from "@typescript-eslint/typescript-estree";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { z } from "zod";

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

interface RouteInfo {
  path: string;
  method: string;
  domain: string;
  action: string;
  requiresAuth: boolean;
  schemaName?: string | undefined;
  serviceName?: string | undefined;
  serviceMethod?: string | undefined;
  node: any;
  location: SourceLocation;
}

export class DynamicAPIExtractor {
  private db: Database;
  private projectRoot: string;
  private apiFilePath: string;
  private fileCache: Map<string, FileInfo> = new Map();
  private schemaRegistry: Map<string, SchemaInfo> = new Map();
  private serviceRegistry: Map<string, ServiceMethodInfo[]> = new Map();

  constructor(
    dbPath: string,
    apiFilePath: string,
    projectRoot: string = process.cwd()
  ) {
    this.db = new Database(dbPath);
    this.apiFilePath = resolve(apiFilePath);
    this.projectRoot = projectRoot;
    this.initializeDatabase();
  }

  private initializeDatabase(): void {
    // Try multiple possible paths for the schema file
    const possiblePaths = [
      join(__dirname, "api-metadata.sql"),
      join(process.cwd(), "src/mcp/api-metadata.sql"),
      join(this.projectRoot, "src/mcp/api-metadata.sql"),
    ];

    let schemaPath: string | null = null;
    for (const path of possiblePaths) {
      if (existsSync(path)) {
        schemaPath = path;
        break;
      }
    }

    if (schemaPath) {
      const schema = readFileSync(schemaPath, "utf-8");
      this.db.exec(schema);
      console.log(
        `[Dynamic API Extractor] Database initialized with schema from: ${schemaPath}`
      );
    } else {
      console.warn(
        "[Dynamic API Extractor] Database schema file not found, creating basic tables..."
      );
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
        array_element_type TEXT,
        referenced_schema TEXT,
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
   * Main extraction method - starts from api.ts and discovers everything
   */
  public async extractFromAPI(): Promise<void> {
    console.log("[Dynamic API Extractor] Starting dynamic API extraction...");
    console.log(`[Dynamic API Extractor] Entry point: ${this.apiFilePath}`);

    try {
      // Clear existing data
      this.clearDatabase();

      // Step 1: Parse the main API file
      const apiFile = await this.parseFile(this.apiFilePath);

      // Step 2: Extract route definitions from createApiRoutes function
      const routes = this.extractRoutesFromAST(apiFile.ast);
      console.log(`[Dynamic API Extractor] Found ${routes.length} routes`);

      // Step 3: Discover all schemas and services referenced in the API
      await this.discoverSchemasAndServices(apiFile);

      // Step 4: Process each endpoint
      const endpoints: DiscoveredEndpoint[] = [];
      for (const route of routes) {
        const endpoint = await this.processEndpoint(route);
        if (endpoint) {
          endpoints.push(endpoint);
        }
      }

      // Step 5: Insert all endpoints into database
      for (const endpoint of endpoints) {
        await this.insertEndpoint(endpoint);
      }

      console.log(
        `[Dynamic API Extractor] ✅ Extracted ${endpoints.length} endpoints`
      );
      this.populateFTSIndex();
    } catch (error) {
      console.error("[Dynamic API Extractor] Error during extraction:", error);
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

    const content = readFileSync(normalizedPath, "utf-8");
    const ast = parse(content, {
      loc: true,
      range: true,
      comments: true,
      tokens: true,
    });

    const fileInfo: FileInfo = { path: normalizedPath, content, ast };
    this.fileCache.set(normalizedPath, fileInfo);

    console.log(
      `[Dynamic API Extractor] Parsed: ${relative(this.projectRoot, normalizedPath)}`
    );
    return fileInfo;
  }

  /**
   * Extract route definitions from the createApiRoutes function
   */
  private extractRoutesFromAST(ast: any): RouteInfo[] {
    const routes: RouteInfo[] = [];

    // Find the createApiRoutes function
    const createApiRoutesFunction = this.findFunctionDeclaration(
      ast,
      "createApiRoutes"
    );
    if (!createApiRoutesFunction) {
      throw new Error("Could not find createApiRoutes function");
    }

    // Extract all app.post() calls from the function body
    this.extractRouteCalls(createApiRoutesFunction.body, routes, false);

    // Also look for protectedRoutes.post() calls
    this.extractProtectedRouteCalls(createApiRoutesFunction.body, routes);

    return routes;
  }

  /**
   * Extract route calls from function body
   */
  private extractRouteCalls(body: any, routes: RouteInfo[], isProtected: boolean): void {
    if (!body || !body.body) return;

    for (const statement of body.body) {
      if (statement.type === AST_NODE_TYPES.ExpressionStatement) {
        const expr = statement.expression;
        if (expr.type === AST_NODE_TYPES.CallExpression) {
          // Skip protected routes when parsing regular routes
          if (expr.callee?.type === AST_NODE_TYPES.MemberExpression &&
              expr.callee.object?.name === "protectedRoutes") {
            continue;
          }
          
          const route = this.parseRouteCall(expr, isProtected);
          if (route) {
            route.location = {
              filePath: this.apiFilePath,
              lineNumber: statement.loc?.start.line || 0,
              columnNumber: statement.loc?.start.column || 0,
            };
            routes.push(route);
          }
        }
      }
    }
  }

  /**
   * Extract protected route calls
   */
  private extractProtectedRouteCalls(body: any, routes: RouteInfo[]): void {
    if (!body || !body.body) return;

    for (const statement of body.body) {
      if (statement.type === AST_NODE_TYPES.VariableDeclaration) {
        for (const declarator of statement.declarations) {
          if (declarator.id?.name === "protectedRoutes" && declarator.init) {
            // Find subsequent calls to protectedRoutes.post
            this.findProtectedRouteCalls(body, routes);
          }
        }
      }
    }
  }

  /**
   * Find protectedRoutes.post calls in the function body
   */
  private findProtectedRouteCalls(body: any, routes: RouteInfo[]): void {
    if (!body || !body.body) return;

    for (const statement of body.body) {
      if (statement.type === AST_NODE_TYPES.ExpressionStatement) {
        const expr = statement.expression;
        if (expr.type === AST_NODE_TYPES.CallExpression) {
          const route = this.parseProtectedRouteCall(expr);
          if (route) {
            route.location = {
              filePath: this.apiFilePath,
              lineNumber: statement.loc?.start.line || 0,
              columnNumber: statement.loc?.start.column || 0,
            };
            routes.push(route);
          }
        }
      }
    }
  }

  /**
   * Parse a single route call (app.post)
   */
  private parseRouteCall(expr: any, isProtected: boolean): RouteInfo | null {
    if (expr.callee?.type === AST_NODE_TYPES.MemberExpression &&
        expr.callee.property?.name === "post" &&
        expr.arguments.length >= 2) {
      
      const pathArg = expr.arguments[0];
      if (pathArg?.type === AST_NODE_TYPES.Literal && typeof pathArg.value === "string") {
        const path = pathArg.value;
        const pathParts = path.split("/").filter((p: string) => p);
        
        if (pathParts.length >= 2) {
          const domain = pathParts[0];
          const action = pathParts[1];
          
          // Look for zValidator call to find schema
          let schemaName: string | undefined;
          let serviceName: string | undefined;
          let serviceMethod: string | undefined;
          
          for (const arg of expr.arguments) {
            if (arg.type === AST_NODE_TYPES.CallExpression) {
              const validatorSchema = this.extractSchemaFromValidator(arg);
              if (validatorSchema) {
                schemaName = validatorSchema;
              }
            }
            if (arg.type === AST_NODE_TYPES.ArrowFunctionExpression) {
              const serviceCall = this.extractServiceCall(arg);
              if (serviceCall) {
                serviceName = serviceCall.serviceName;
                serviceMethod = serviceCall.methodName;
              }
            }
          }
          
          return {
            path,
            method: "POST",
            domain,
            action,
            requiresAuth: isProtected,
            schemaName,
            serviceName,
            serviceMethod,
            node: expr,
            location: {
              filePath: this.apiFilePath,
              lineNumber: 0,
              columnNumber: 0,
            },
          };
        }
      }
    }
    return null;
  }

  /**
   * Parse a protected route call (protectedRoutes.post)
   */
  private parseProtectedRouteCall(expr: any): RouteInfo | null {
    if (expr.callee?.type === AST_NODE_TYPES.MemberExpression &&
        expr.callee.object?.name === "protectedRoutes" &&
        expr.callee.property?.name === "post") {
      
      const route = this.parseRouteCall(expr, true);
      if (route) {
        route.requiresAuth = true;
      }
      return route;
    }
    return null;
  }

  /**
   * Extract schema name from zValidator call
   */
  private extractSchemaFromValidator(expr: any): string | null {
    if (expr.callee?.name === "zValidator" && expr.arguments.length >= 2) {
      const schemaArg = expr.arguments[1];
      if (schemaArg?.type === AST_NODE_TYPES.Identifier) {
        return schemaArg.name;
      }
    }
    return null;
  }

  /**
   * Extract service call from arrow function
   */
  private extractServiceCall(arrowFunc: any): { serviceName: string; methodName: string } | null {
    if (arrowFunc.body?.type === AST_NODE_TYPES.BlockStatement) {
      for (const statement of arrowFunc.body.body) {
        if (statement.type === AST_NODE_TYPES.VariableDeclaration) {
          for (const declarator of statement.declarations) {
            if (declarator.init?.type === AST_NODE_TYPES.AwaitExpression) {
              const awaitExpr = declarator.init.argument;
              if (awaitExpr?.type === AST_NODE_TYPES.CallExpression) {
                const memberExpr = awaitExpr.callee;
                if (memberExpr?.type === AST_NODE_TYPES.MemberExpression) {
                  const serviceAccess = memberExpr.object;
                  if (serviceAccess?.type === AST_NODE_TYPES.MemberExpression &&
                      serviceAccess.object?.name === "services") {
                    return {
                      serviceName: serviceAccess.property?.name || "unknown",
                      methodName: memberExpr.property?.name || "unknown"
                    };
                  }
                }
              }
            }
          }
        }
      }
    }
    return null;
  }

  /**
   * Discover all schemas and services by analyzing imports
   */
  private async discoverSchemasAndServices(apiFile: FileInfo): Promise<void> {
    console.log("[Dynamic API Extractor] Discovering schemas and services...");

    // Find all import statements
    const imports = this.extractImports(apiFile.ast);

    for (const importInfo of imports) {
      const importPath = this.resolveImportPath(
        importInfo.source,
        this.apiFilePath
      );

      if (importPath && existsSync(importPath)) {
        try {
          const importedFile = await this.parseFile(importPath);

          // Check if this is a schema file
          if (
            importPath.includes("/schemas/") ||
            importInfo.source.includes("schemas")
          ) {
            await this.discoverSchemasInFile(importedFile);
          }

          // Check if this is a service file
          if (
            importPath.includes("/services/") ||
            importInfo.source.includes("services")
          ) {
            await this.discoverServicesInFile(importedFile);
          }
        } catch (error) {
          console.warn(
            `[Dynamic API Extractor] Failed to parse import: ${importPath}`,
            error
          );
        }
      }
    }

    // Also discover by scanning directories
    await this.scanDirectoryForSchemas(
      join(this.projectRoot, "src/api/schemas")
    );
    await this.scanDirectoryForServices(join(this.projectRoot, "src/services"));
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

      if (stat.isFile() && file.endsWith(".ts") && !file.endsWith(".test.ts")) {
        try {
          const fileInfo = await this.parseFile(filePath);
          await this.discoverSchemasInFile(fileInfo);
        } catch (error) {
          console.warn(
            `[Dynamic API Extractor] Failed to parse schema file: ${filePath}`,
            error
          );
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

      if (stat.isFile() && file.endsWith(".service.ts")) {
        try {
          const fileInfo = await this.parseFile(filePath);
          await this.discoverServicesInFile(fileInfo);
        } catch (error) {
          console.warn(
            `[Dynamic API Extractor] Failed to parse service file: ${filePath}`,
            error
          );
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
      if (
        exportDecl.type === AST_NODE_TYPES.ExportNamedDeclaration &&
        exportDecl.declaration?.type === AST_NODE_TYPES.VariableDeclaration
      ) {
        for (const declarator of exportDecl.declaration.declarations) {
          if (
            declarator.id.type === AST_NODE_TYPES.Identifier &&
            declarator.id.name.endsWith("Schema")
          ) {
            const schemaName = declarator.id.name;
            const schemaInfo: SchemaInfo = {
              name: schemaName,
              filePath: fileInfo.path,
              lineNumber: declarator.loc?.start.line || 0,
              properties: {}, // Will be filled by analyzing the Zod schema
            };

            this.schemaRegistry.set(schemaName, schemaInfo);
            console.log(
              `[Dynamic API Extractor] Found schema: ${schemaName} in ${relative(this.projectRoot, fileInfo.path)}`
            );
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
      if (classDecl.id?.name.includes("Service")) {
        const methods = this.extractMethodsFromClass(classDecl, fileInfo.path);
        serviceMethods.push(...methods);
      }
    }

    if (serviceMethods.length > 0) {
      this.serviceRegistry.set(serviceClassName, serviceMethods);
      console.log(
        `[Dynamic API Extractor] Found ${serviceMethods.length} methods in ${serviceClassName}`
      );
    }
  }

  /**
   * Process a single endpoint and gather all its metadata
   */
  private async processEndpoint(
    route: RouteInfo
  ): Promise<DiscoveredEndpoint | null> {
    const endpoint: DiscoveredEndpoint = {
      name: `${route.domain}.${route.action}`,
      domain: route.domain,
      method: route.action,
      description: this.generateDescription(route.domain, route.action),
      httpPath: `/rpc${route.path}`,
      requiresAuth: route.requiresAuth,
      category: this.inferCategory(route.domain),
      sourceLocation: route.location,
    };

    // Find input schema from the route definition
    if (route.schemaName && this.schemaRegistry.has(route.schemaName)) {
      const schemaInfo = this.schemaRegistry.get(route.schemaName);
      if (schemaInfo) {
        endpoint.inputSchemaInfo = schemaInfo;
      }
    }

    // Find service method information
    if (route.serviceName && route.serviceMethod) {
      const serviceKey = route.serviceName;
      if (this.serviceRegistry.has(serviceKey)) {
        const serviceMethods = this.serviceRegistry.get(serviceKey)!;
        const serviceMethod = serviceMethods.find((m) => m.name === route.serviceMethod);
        if (serviceMethod) {
          endpoint.serviceInfo = serviceMethod;
          const outputSchema = this.inferOutputSchemaFromReturnType(
            serviceMethod.returnType
          );
          if (outputSchema) {
            endpoint.outputSchemaInfo = outputSchema;
          }
        }
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
      if (
        node.type === AST_NODE_TYPES.FunctionDeclaration &&
        node.id?.name === functionName
      ) {
        return node;
      }
      if (
        node.type === AST_NODE_TYPES.ExportNamedDeclaration &&
        node.declaration?.type === AST_NODE_TYPES.FunctionDeclaration &&
        node.declaration.id?.name === functionName
      ) {
        return node.declaration;
      }
    }
    return null;
  }


  private extractImports(
    ast: any
  ): Array<{ source: string; specifiers: string[] }> {
    const imports: Array<{ source: string; specifiers: string[] }> = [];
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

  private resolveImportPath(
    importSource: string,
    fromFile: string
  ): string | null {
    const basePath = dirname(fromFile);

    // Handle relative imports
    if (importSource.startsWith(".")) {
      const resolved = resolve(basePath, importSource);

      // Try different extensions
      for (const ext of [".ts", ".js", "/index.ts", "/index.js"]) {
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
      if (
        node.type === AST_NODE_TYPES.ExportNamedDeclaration ||
        node.type === AST_NODE_TYPES.ExportDefaultDeclaration
      ) {
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

  private extractMethodsFromClass(
    classNode: any,
    filePath: string
  ): ServiceMethodInfo[] {
    const methods: ServiceMethodInfo[] = [];

    if (!classNode.body?.body) return methods;

    for (const member of classNode.body.body) {
      if (
        member.type === AST_NODE_TYPES.MethodDefinition &&
        member.key.type === AST_NODE_TYPES.Identifier &&
        member.value.async
      ) {
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
      return this.typeAnnotationToString(
        methodNode.value.returnType.typeAnnotation
      );
    }

    // Fallback to inference from method name
    return this.inferReturnTypeFromMethodName(methodNode.key.name);
  }

  private extractParametersFromMethod(
    methodNode: any
  ): Array<{ name: string; type: string; optional: boolean }> {
    const parameters: Array<{ name: string; type: string; optional: boolean }> =
      [];

    if (!methodNode.value.params) return parameters;

    for (const param of methodNode.value.params) {
      if (param.type === AST_NODE_TYPES.Identifier) {
        parameters.push({
          name: param.name,
          type: param.typeAnnotation
            ? this.typeAnnotationToString(param.typeAnnotation.typeAnnotation)
            : "any",
          optional: param.optional || false,
        });
      }
    }

    return parameters;
  }


  /**
   * Utility methods
   */
  private extractServiceClassName(filePath: string): string {
    const filename = filePath.split("/").pop() || "";
    return filename.replace(".service.ts", "");
  }


  private typeAnnotationToString(typeNode: any): string {
    if (!typeNode) return "unknown";

    switch (typeNode.type) {
      case AST_NODE_TYPES.TSStringKeyword:
        return "string";
      case AST_NODE_TYPES.TSNumberKeyword:
        return "number";
      case AST_NODE_TYPES.TSBooleanKeyword:
        return "boolean";
      case AST_NODE_TYPES.TSTypeReference:
        return typeNode.typeName?.name || "unknown";
      default:
        return "unknown";
    }
  }

  private inferReturnTypeFromMethodName(methodName: string): string {
    const typeMap: Record<string, string> = {
      create: "CreatedEntity",
      update: "UpdatedEntity",
      get: "Entity",
      list: "Entity[]",
      delete: "{ success: boolean }",
      login: "AuthResponse",
      register: "AuthResponse",
    };

    return typeMap[methodName] || "unknown";
  }

  private generateDescription(domain: string, method: string): string {
    const methodDescriptions: Record<string, string> = {
      create: "Create a new",
      get: "Retrieve details for a specific",
      update: "Update properties of an existing",
      delete: "Delete an existing",
      list: "List all",
      login: "Authenticate user and create session",
      register: "Register a new user account",
    };

    const domainNames: Record<string, string> = {
      auth: "authentication",
      tests: "test template",
      rounds: "round",
      user: "user profile",
    };

    const methodDesc =
      methodDescriptions[method] || `Perform ${method} operation on`;
    const domainName = domainNames[domain] || domain;

    return `${methodDesc} ${domainName}`;
  }

  private inferCategory(domain: string): string {
    const categoryMap: Record<string, string> = {
      auth: "Authentication",
      tests: "Test Management",
      rounds: "Round Management",
      user: "User Management",
    };

    return categoryMap[domain] || "Other";
  }


  private inferOutputSchemaFromReturnType(
    _returnType: string
  ): SchemaInfo | undefined {
    // For now, return undefined - could be enhanced to create synthetic schemas
    return undefined;
  }

  /**
   * Database operations
   */
  private clearDatabase(): void {
    try {
      // Clear tables in reverse dependency order.
      // The `api_search` FTS table is handled separately in `populateFTSIndex`.
      const tables = [
        "api_tags",
        "api_examples",
        "api_parameters",
        "api_endpoints",
      ];

      for (const table of tables) {
        try {
          this.db.exec(`DELETE FROM ${table}`);
        } catch (error) {
          // Ignore table not found errors - tables might not exist yet
          if (!(error as any).message?.includes("no such table")) {
            console.warn(
              `[Dynamic API Extractor] Warning clearing table ${table}:`,
              error
            );
          }
        }
      }
    } catch (error) {
      console.warn(
        "[Dynamic API Extractor] Warning during database clear:",
        error
      );
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
      endpoint.description || "",
      endpoint.httpPath,
      endpoint.requiresAuth ? 1 : 0,
      endpoint.category,
      endpoint.sourceLocation.filePath,
      endpoint.sourceLocation.lineNumber,
      endpoint.inputSchemaInfo?.filePath || "",
      endpoint.inputSchemaInfo?.lineNumber || 0,
      endpoint.serviceInfo?.filePath || "",
      endpoint.serviceInfo?.lineNumber || 0
    );

    const endpointId = result.lastInsertRowid as number;

    // Insert parameters if we have schema info
    if (endpoint.inputSchemaInfo) {
      await this.insertParametersFromSchemaInfo(
        endpointId,
        "input",
        endpoint.inputSchemaInfo
      );
    }

    if (endpoint.serviceInfo) {
      await this.insertParametersFromServiceInfo(
        endpointId,
        "output",
        endpoint.serviceInfo
      );
    }

    // Insert basic example
    await this.insertBasicExample(endpointId, endpoint.domain, endpoint.method);

    console.log(`[Dynamic API Extractor] Inserted endpoint: ${endpoint.name}`);
  }

  private getZodTypeName(zodDef: any): string {
    if (!zodDef || !zodDef._def || !zodDef._def.typeName) return "any";
    const typeName = zodDef._def.typeName;
    switch (typeName) {
      case "ZodString":
        return "string";
      case "ZodNumber":
        return "number";
      case "ZodBoolean":
        return "boolean";
      case "ZodDate":
        return "date";
      case "ZodObject":
        return "object";
      case "ZodArray":
        return "array";
      default:
        return typeName.replace("Zod", "").toLowerCase();
    }
  }

  private getZodTypeInfo(zodDef: any): { type: string; arrayElementType?: string; description?: string } {
    if (!zodDef || !zodDef._def || !zodDef._def.typeName) return { type: "any" };
    
    const typeName = zodDef._def.typeName;
    
    switch (typeName) {
      case "ZodString":
        return { type: "string" };
      case "ZodNumber":
        return { type: "number" };
      case "ZodBoolean":
        return { type: "boolean" };
      case "ZodDate":
        return { type: "date" };
      case "ZodObject":
        return { type: "object" };
      case "ZodArray":
        const elementType = this.getZodTypeInfo(zodDef._def.type);
        return { 
          type: "array", 
          arrayElementType: elementType.type,
          description: elementType.arrayElementType ? 
            `array of ${elementType.arrayElementType}` : 
            `array of ${elementType.type}`
        };
      case "ZodOptional":
        return this.getZodTypeInfo(zodDef._def.innerType);
      case "ZodDefault":
        return this.getZodTypeInfo(zodDef._def.innerType);
      default:
        return { type: typeName.replace("Zod", "").toLowerCase() };
    }
  }

  private resolveSchemaReference(zodDef: any, schemaModule: any): { type: string; arrayElementType?: string; description?: string; referencedSchema?: string } {
    if (!zodDef || !zodDef._def) return { type: "any" };
    
    const typeName = zodDef._def.typeName;
    
    if (typeName === "ZodArray") {
      const elementType = zodDef._def.type;
      
      // Check if the array element is a reference to another schema
      if (elementType && elementType._def && elementType._def.typeName === "ZodObject") {
        // Try to find the referenced schema by comparing shape
        const elementShape = elementType.shape;
        for (const [schemaName, schema] of Object.entries(schemaModule)) {
          if (schema && typeof schema === 'object' && (schema as any).shape) {
            const schemaShape = (schema as any).shape;
            if (this.compareZodShapes(elementShape, schemaShape)) {
              return {
                type: "array",
                arrayElementType: "object",
                description: `array of ${schemaName}`,
                referencedSchema: schemaName
              };
            }
          }
        }
      }
      
      const elementTypeInfo = this.getZodTypeInfo(elementType);
      return {
        type: "array",
        arrayElementType: elementTypeInfo.type,
        description: `array of ${elementTypeInfo.type}`
      };
    }
    
    return this.getZodTypeInfo(zodDef);
  }

  private compareZodShapes(shape1: any, shape2: any): boolean {
    if (!shape1 || !shape2) return false;
    
    const keys1 = Object.keys(shape1);
    const keys2 = Object.keys(shape2);
    
    if (keys1.length !== keys2.length) return false;
    
    for (const key of keys1) {
      if (!keys2.includes(key)) return false;
      
      const type1 = shape1[key]?._def?.typeName;
      const type2 = shape2[key]?._def?.typeName;
      
      if (type1 !== type2) return false;
    }
    
    return true;
  }

  private extractNestedSchemaParameters(zodSchema: any, schemaModule: any, parameterName: string): Array<{name: string; type: string; description: string; path: string}> {
    const nestedParams: Array<{name: string; type: string; description: string; path: string}> = [];
    
    if (!zodSchema || !zodSchema.shape) return nestedParams;
    
    const shape = zodSchema.shape;
    
    for (const [fieldName, fieldDef] of Object.entries(shape)) {
      const fieldPath = `${parameterName}.${fieldName}`;
      const typeInfo = this.resolveSchemaReference(fieldDef, schemaModule);
      
      nestedParams.push({
        name: fieldName,
        type: typeInfo.type,
        description: typeInfo.description || typeInfo.referencedSchema || typeInfo.type,
        path: fieldPath
      });
      
      // If this is a referenced schema, recursively extract its parameters
      if (typeInfo.referencedSchema && schemaModule[typeInfo.referencedSchema]) {
        const referencedSchema = schemaModule[typeInfo.referencedSchema];
        const nestedFields = this.extractNestedSchemaParameters(referencedSchema, schemaModule, fieldPath);
        nestedParams.push(...nestedFields);
      }
    }
    
    return nestedParams;
  }

  private async insertParametersFromSchemaInfo(
    endpointId: number,
    parameterType: "input" | "output",
    schemaInfo: SchemaInfo
  ): Promise<void> {
    try {
      const schemaModule = await import(schemaInfo.filePath);
      const zodSchema = schemaModule[schemaInfo.name];

      if (zodSchema && zodSchema.shape) {
        const shape = zodSchema.shape;
        const insertParam = this.db.prepare(`
          INSERT INTO api_parameters (
            endpoint_id, parameter_name, parameter_type, data_type,
            is_required, is_optional, description, source_schema_name,
            array_element_type, referenced_schema, nested_path
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const transaction = this.db.transaction(() => {
          for (const paramName in shape) {
            const paramDef = shape[paramName];
            const typeInfo = this.resolveSchemaReference(paramDef, schemaModule);
            
            insertParam.run(
              endpointId,
              paramName,
              parameterType,
              typeInfo.type,
              !paramDef.isOptional(),
              paramDef.isOptional(),
              typeInfo.description || paramDef.description || "",
              schemaInfo.name,
              typeInfo.arrayElementType || null,
              typeInfo.referencedSchema || null,
              paramName
            );
            
            // If this is an array of objects with a referenced schema, add nested parameters
            if (typeInfo.referencedSchema && schemaModule[typeInfo.referencedSchema]) {
              const referencedSchema = schemaModule[typeInfo.referencedSchema];
              const nestedParams = this.extractNestedSchemaParameters(referencedSchema, schemaModule, paramName);
              
              for (const nestedParam of nestedParams) {
                insertParam.run(
                  endpointId,
                  nestedParam.name,
                  parameterType,
                  nestedParam.type,
                  true, // Nested parameters are typically required
                  false,
                  nestedParam.description,
                  typeInfo.referencedSchema,
                  null,
                  null,
                  nestedParam.path
                );
              }
            }
          }
        });
        transaction();
        return;
      }
    } catch (e) {
      console.error(
        `[Dynamic API Extractor] Could not dynamically import or parse schema ${schemaInfo.name} from ${schemaInfo.filePath}`,
        e
      );
    }

    const insertParam = this.db.prepare(`
      INSERT INTO api_parameters (
        endpoint_id, parameter_name, parameter_type, data_type,
        is_required, is_optional, description, source_schema_name,
        array_element_type, referenced_schema, nested_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertParam.run(
      endpointId,
      "schema_defined",
      parameterType,
      "object",
      1,
      0,
      `Parameters defined in ${schemaInfo.name}`,
      schemaInfo.name,
      null,
      null,
      "schema_defined"
    );
  }

  private async insertParametersFromServiceInfo(
    endpointId: number,
    _parameterType: "input" | "output",
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
        "input", // Service method parameters are inputs
        param.type,
        param.optional ? 0 : 1,
        param.optional ? 1 : 0,
        `Service method parameter: ${param.name}`
      );
    }

    // Insert return type as output parameter
    if (serviceInfo.returnType && serviceInfo.returnType !== "unknown") {
      const insertParam = this.db.prepare(`
        INSERT INTO api_parameters (
          endpoint_id, parameter_name, parameter_type, data_type,
          is_required, is_optional, description
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      insertParam.run(
        endpointId,
        "returnValue",
        "output",
        serviceInfo.returnType,
        1,
        0,
        `Return type: ${serviceInfo.returnType}`
      );
    }
  }

  private async insertBasicExample(
    endpointId: number,
    domain: string,
    method: string
  ): Promise<void> {
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
      "input",
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
      "output",
      `${method} output example`,
      `Example output for ${domain}.${method}`,
      JSON.stringify(outputExample, null, 2)
    );
  }

  private generateInputExample(domain: string, method: string): any {
    // Generate domain-specific examples
    if (domain === "auth") {
      if (method === "register") {
        return {
          email: "user@example.com",
          password: "Password123!",
          firstName: "John",
          lastName: "Doe",
        };
      }
      if (method === "login") {
        return {
          email: "user@example.com",
          password: "Password123!",
        };
      }
    }

    if (domain === "tests") {
      if (method === "create") {
        return {
          testId: "custom-test",
          name: "Custom Test",
          description: "A custom putting test",
          holeCount: 3,
          distances: [1.0, 2.5, 4.0],
        };
      }
    }

    if (domain === "rounds") {
      if (method === "create") {
        return {
          testId: "putting-9",
          testName: "9-Hole Putting Test",
          date: new Date().toISOString(),
          holes: [{ hole: 1, distance: 1.5, putts: 2 }],
        };
      }
    }

    return {};
  }

  private generateOutputExample(domain: string, method: string): any {
    if (domain === "auth" && ["login", "register"].includes(method)) {
      return {
        token: "jwt-token-here",
        user: {
          id: "user-123",
          email: "user@example.com",
          firstName: "John",
          lastName: "Doe",
        },
      };
    }

    if (["create", "update", "delete"].includes(method)) {
      return { success: true };
    }

    if (method === "list") {
      return { items: [], total: 0 };
    }

    return { success: true };
  }

  private populateFTSIndex(): void {
    console.log("[Dynamic API Extractor] Populating FTS index...");

    try {
      // Re-create the FTS table from scratch to ensure it is clean.
      // This avoids a bug with `DELETE FROM` on FTS5 tables in bun:sqlite.
      this.db.exec("DROP TABLE IF EXISTS api_search");
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS api_search USING fts5(
          endpoint_id UNINDEXED,
          name,
          description,
          category,
          parameters
        )
      `);

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

      // Use a transaction for much faster bulk inserts
      const transaction = this.db.transaction(() => {
        for (const endpoint of endpoints as any[]) {
          insertFTS.run(
            endpoint.id,
            endpoint.name || "",
            endpoint.description || "",
            endpoint.category || "",
            endpoint.parameters || ""
          );
        }
      });

      transaction();

      console.log(
        `[Dynamic API Extractor] ✅ FTS index populated with ${endpoints.length} entries`
      );
    } catch (error) {
      console.error(
        "[Dynamic API Extractor] Error populating FTS index:",
        error
      );
    }
  }

  public close(): void {
    this.db.close();
  }
}
// Export for use in the MCP server
export { DynamicAPIExtractor as SimpleAPIExtractor };
