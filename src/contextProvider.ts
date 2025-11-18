import { McpHttpClient } from './mcpClient';

export interface UserContext {
  userId: string;
  userName?: string;
  defaultProject?: string;
  lastReferencedProject?: string;
  timezone?: string;
}

export interface EntityCatalog {
  [resourceType: string]: Array<{ id: string; name: string; [key: string]: any }>;
}

export class ContextProvider {
  private mcp: McpHttpClient;
  private userSessions: Map<string, UserContext> = new Map();
  private entityCache: EntityCatalog = {};
  private discoveredResources: Array<{ uri: string; name?: string; description?: string; mimeType?: string }> = [];
  private lastEntityRefresh: number = 0;
  private entityRefreshInterval: number = 5 * 60 * 1000; // 5 minutes (same as tool cache)
  private refreshInterval: NodeJS.Timeout | null = null;
  private refreshIntervalMs: number;

  constructor(mcp: McpHttpClient, refreshIntervalMs: number = 5 * 60 * 1000) {
    this.mcp = mcp;
    this.refreshIntervalMs = refreshIntervalMs;
  }

  async initialize(): Promise<void> {
    await this.refreshEntityCatalog();
    // Set up periodic refresh
    this.refreshInterval = setInterval(() => {
      this.refreshEntityCatalog().catch(err => {
        console.error('Entity catalog refresh failed:', err);
      });
    }, this.refreshIntervalMs);
  }

  async getUserContext(userId: string): Promise<UserContext> {
    let context = this.userSessions.get(userId);
    
    if (!context) {
      context = {
        userId,
        timezone: 'America/New_York', // Default
      };
      this.userSessions.set(userId, context);
    }

    // Refresh entity catalog if stale
    const now = Date.now();
    if (now - this.lastEntityRefresh > this.entityRefreshInterval) {
      await this.refreshEntityCatalog();
    }

    return context;
  }

  async getEntityCatalog(): Promise<EntityCatalog> {
    // Refresh if stale
    const now = Date.now();
    if (now - this.lastEntityRefresh > this.entityRefreshInterval) {
      await this.refreshEntityCatalog();
    }

    return this.entityCatalog;
  }

  private async refreshEntityCatalog(): Promise<void> {
    try {
      // First, discover available resources from MCP server
      await this.discoverResources();

      // Clear existing cache
      this.entityCache = {};

      // Fetch data for each discovered resource
      for (const resource of this.discoveredResources) {
        const uri = resource.uri;
        
        // Extract resource type from URI (e.g., "projects://all" -> "projects")
        const uriMatch = uri.match(/^([^:]+):/);
        if (!uriMatch) continue;
        
        const resourceType = uriMatch[1];
        
        try {
          const resourceRes = await this.mcp.readResource(uri);
          const resourceText = resourceRes?.contents?.[0]?.text || '[]';
          
          // Try to parse as JSON
          let items: any[] = [];
          try {
            const parsed = JSON.parse(resourceText);
            items = Array.isArray(parsed) ? parsed : [parsed];
          } catch (e) {
            // If not JSON, skip this resource
            console.warn(`Resource ${uri} did not return valid JSON, skipping`);
            continue;
          }

          // Map items to a common format
          const entities = items.slice(0, 100).map((item: any) => {
            const entity: any = {
              id: item.id || item[`${resourceType}Id`] || String(item._id || ''),
              name: item.name || item[`${resourceType}Name`] || item.fileName || item.title || '',
            };

            // Include all other properties from the item
            for (const [key, value] of Object.entries(item)) {
              if (key !== 'id' && key !== 'name' && key !== '_id') {
                entity[key] = value;
              }
            }

            return entity;
          });

          this.entityCache[resourceType] = entities;
          console.log(`Fetched ${entities.length} ${resourceType} entities`);
        } catch (e) {
          console.error(`Failed to fetch resource ${uri}:`, e);
        }
      }

      this.lastEntityRefresh = Date.now();
      
      // Log summary
      const summary = Object.entries(this.entityCache)
        .map(([type, entities]) => `${entities.length} ${type}`)
        .join(', ');
      console.log(`Entity catalog refreshed: ${summary || 'no entities'}`);
    } catch (error) {
      console.error('Failed to refresh entity catalog:', error);
    }
  }

  private async discoverResources(): Promise<void> {
    try {
      const result = await this.mcp.listResources();
      const resources = result?.resources || [];
      
      // Filter for "all" resources (e.g., "projects://all", "clients://all")
      // These are typically the list endpoints
      this.discoveredResources = resources.filter((r: any) => {
        const uri = r.uri || '';
        return uri.endsWith('://all') || uri.includes('://all/');
      });

      console.log(`Discovered ${this.discoveredResources.length} resource types: ${this.discoveredResources.map((r: any) => r.uri).join(', ')}`);
    } catch (error) {
      console.error('Failed to discover resources:', error);
      // Fallback to known resources if discovery fails
      this.discoveredResources = [
        { uri: 'projects://all' },
        { uri: 'users://all' },
        { uri: 'documents://all' },
      ];
    }
  }

  getExamples(): Array<{ query: string; plan: any }> {
    return [
      {
        query: 'send me the ecp checklist',
        plan: {
          calls: [{ tool: 'send_document', args: { query: 'ecp checklist' } }],
          needs_confirmation: false,
        },
      },
      {
        query: 'what is the project deadline for Project Aspen',
        plan: {
          calls: [{ tool: 'send_document', args: { query: 'project deadline Project Aspen' } }],
          entity_resolutions: [{ entityType: 'project', entityValue: 'Project Aspen', resolvedId: 'proj-123' }],
          needs_confirmation: false,
        },
      },
      {
        query: 'where is the submittal package',
        plan: {
          calls: [{ tool: 'send_document', args: { query: 'submittal package' } }],
          needs_confirmation: false,
        },
      },
      {
        query: 'list all projects',
        plan: {
          calls: [],
          fallback_text: 'Use /projects command to list all projects',
        },
      },
      {
        query: 'show me users',
        plan: {
          calls: [],
          fallback_text: 'Use /users command to list all users',
        },
      },
    ];
  }

  updateUserContext(userId: string, updates: Partial<UserContext>): void {
    const context = this.userSessions.get(userId) || { userId };
    Object.assign(context, updates);
    this.userSessions.set(userId, context);
  }

  private get entityCatalog(): EntityCatalog {
    return this.entityCache;
  }

  destroy(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }
}

