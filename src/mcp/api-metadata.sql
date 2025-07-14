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