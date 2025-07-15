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

// We'll create a Hono app by importing the necessary services
// This is a simplified approach that doesn't require exposing createApiRoutes

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

  constructor(config: WatcherConfig, _createHonoApp: () => any) {
    this.config = config;
    // _createHonoApp is not currently used but kept for future extensibility
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
filename.includes('hono')
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
      const apiFilePath = join(process.cwd(), "src/api/api.ts");
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
  createHonoApp: () => any
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

  return new APIFileWatcher(config, createHonoApp);
}
