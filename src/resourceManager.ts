import { McpHttpClient } from './mcpClient';

export interface DiscoveredResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface DiscoveredTool {
  name: string;
  description?: string;
  inputSchema?: any;
}

export class ResourceManager {
  private mcp: McpHttpClient;
  private resources: DiscoveredResource[] = [];
  private tools: DiscoveredTool[] = [];
  private refreshInterval: NodeJS.Timeout | null = null;
  private refreshIntervalMs: number;
  private lastRefresh: number = 0;

  constructor(mcp: McpHttpClient, refreshIntervalMs: number = 1 * 60 * 1000) {
    this.mcp = mcp;
    this.refreshIntervalMs = refreshIntervalMs;
  }

  async initialize(): Promise<void> {
    await this.refresh();
    this.refreshInterval = setInterval(() => {
      this.refresh().catch(err => {
        console.error('Resource manager refresh failed:', err);
      });
    }, this.refreshIntervalMs);
  }

  async refresh(): Promise<void> {
    try {
      // Refresh tools
      const toolsResult = await this.mcp.listTools();
      this.tools = (toolsResult?.tools || []).map((t: any) => ({
        name: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || {},
      }));

      // Refresh resources
      const resourcesResult = await this.mcp.listResources();
      this.resources = (resourcesResult?.resources || []).filter((r: any) => {
        const uri = r.uri || '';
        // Only include "all" resources (list endpoints)
        return uri.endsWith('://all') || uri.includes('://all/');
      });

      this.lastRefresh = Date.now();
      console.log(`Resource manager refreshed: ${this.tools.length} tools, ${this.resources.length} resources`);
    } catch (error) {
      console.error('Failed to refresh resource manager:', error);
      throw error;
    }
  }

  getResources(): DiscoveredResource[] {
    return [...this.resources];
  }

  getTools(): DiscoveredTool[] {
    return [...this.tools];
  }

  getResourceByType(type: string): DiscoveredResource | undefined {
    return this.resources.find(r => {
      const uri = r.uri || '';
      const match = uri.match(/^([^:]+):/);
      return match && match[1] === type;
    });
  }

  getResourceUri(type: string): string | undefined {
    const resource = this.getResourceByType(type);
    return resource?.uri;
  }

  async ensureFresh(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRefresh > this.refreshIntervalMs) {
      await this.refresh();
    }
  }

  destroy(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }
}







