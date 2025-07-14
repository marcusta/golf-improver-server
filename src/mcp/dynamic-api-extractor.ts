/**
 * Dynamic API Extractor - True metaprogramming approach
 *
 * Starting from orpc-api.ts, this extractor:
 * 1. Parses the API structure using TypeScript AST
 * 2. Follows import chains to find Zod schemas and services
 * 3. Analyzes service methods to extract return types
 * 4. Builds a complete API database dynamically
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
    console.log("[Dynamic API Extractor] Starting dynamic API extraction...");
    console.log(`[Dynamic API Extractor] Entry point: ${this.apiFilePath}`);

    try {
      // Clear existing data
      this.clearDatabase();

      // Step 1: Parse the main API file
      const apiFile = await this.parseFile(this.apiFilePath);

      // Step 2: Extract procedure definitions from createProcedures function
      const procedures = this.extractProceduresFromAST(apiFile.ast);
      console.log(
        `[Dynamic API Extractor] Found ${Object.keys(procedures).length} domains`
      );

      // Step 3: Discover all schemas and services referenced in the API
      await this.discoverSchemasAndServices(apiFile);

      // Step 4: Process each endpoint
      const endpoints: DiscoveredEndpoint[] = [];
      for (const [domain, methods] of Object.entries(procedures)) {
        for (const [method, procedureInfo] of Object.entries(methods as any)) {
          const endpoint = await this.processEndpoint(
            domain,
            method,
            procedureInfo,
            apiFile
          );
          if (endpoint) {
            endpoints.push(endpoint);
          }
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
   * Extract procedure definitions from the createProcedures function
   */
  private extractProceduresFromAST(
    ast: any
  ): Record<string, Record<string, any>> {
    const procedures: Record<string, Record<string, any>> = {};

    // Find the createProcedures function
    const createProceduresFunction = this.findFunctionDeclaration(
      ast,
      "createProcedures"
    );
    if (!createProceduresFunction) {
      throw new Error("Could not find createProcedures function");
    }

    // Extract the return statement object
    const returnStatement = this.findReturnStatement(createProceduresFunction);
    if (
      !returnStatement ||
      returnStatement.argument?.type !== AST_NODE_TYPES.ObjectExpression
    ) {
      throw new Error(
        "Could not find procedures object in createProcedures return statement"
      );
    }

    // Parse the object structure
    for (const property of returnStatement.argument.properties) {
      if (
        property.type === AST_NODE_TYPES.Property &&
        property.key.type === AST_NODE_TYPES.Identifier
      ) {
        const domain = property.key.name;

        if (property.value.type === AST_NODE_TYPES.ObjectExpression) {
          procedures[domain] = {};

          for (const methodProperty of property.value.properties) {
            if (
              methodProperty.type === AST_NODE_TYPES.Property &&
              methodProperty.key.type === AST_NODE_TYPES.Identifier
            ) {
              const method = methodProperty.key.name;
              procedures[domain][method] = {
                node: methodProperty,
                location: {
                  filePath: this.apiFilePath,
                  lineNumber: methodProperty.loc?.start.line || 0,
                  columnNumber: methodProperty.loc?.start.column || 0,
                },
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
    const inputSchemaName = this.extractInputSchemaFromProcedure(
      procedureInfo.node
    );
    if (inputSchemaName && this.schemaRegistry.has(inputSchemaName)) {
      endpoint.inputSchemaInfo = this.schemaRegistry.get(inputSchemaName);
    }

    // Find service method information
    const serviceKey = this.getServiceKey(domain);
    if (this.serviceRegistry.has(serviceKey)) {
      const serviceMethods = this.serviceRegistry.get(serviceKey)!;
      const serviceMethod = serviceMethods.find((m) => m.name === method);
      if (serviceMethod) {
        endpoint.serviceInfo = serviceMethod;
        endpoint.outputSchemaInfo = this.inferOutputSchemaFromReturnType(
          serviceMethod.returnType
        );
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

  private extractInputSchemaFromProcedure(procedureNode: any): string | null {
    // Look for os.input(SomeSchema) pattern
    if (procedureNode.value?.type === AST_NODE_TYPES.CallExpression) {
      const callee = procedureNode.value.callee;
      if (
        callee?.type === AST_NODE_TYPES.MemberExpression &&
        callee.property?.name === "handler"
      ) {
        const object = callee.object;
        if (
          object?.type === AST_NODE_TYPES.CallExpression &&
          object.callee?.property?.name === "input"
        ) {
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
    const filename = filePath.split("/").pop() || "";
    return filename.replace(".service.ts", "");
  }

  private getServiceKey(domain: string): string {
    // Map domain names to service file names
    const domainToService: Record<string, string> = {
      auth: "auth",
      tests: "test-templates",
      rounds: "rounds",
      user: "user",
    };

    return domainToService[domain] || domain;
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

  private inferAuthRequirement(domain: string, method: string): boolean {
    if (domain === "auth" && ["login", "register"].includes(method)) {
      return false;
    }
    if (domain === "tests" && method === "list") {
      return false;
    }
    if (domain === "tests" && method === "create") {
      return false;
    }
    return true;
  }

  private inferOutputSchemaFromReturnType(
    returnType: string
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

  private async insertParametersFromSchemaInfo(
    endpointId: number,
    type: "input" | "output",
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
      "schema_defined",
      type,
      "object",
      1,
      0,
      `Parameters defined in ${schemaInfo.name}`,
      schemaInfo.name
    );
  }

  private async insertParametersFromServiceInfo(
    endpointId: number,
    type: "input" | "output",
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
