"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ResourceManager = void 0;
class ResourceManager {
    constructor(mcp, refreshIntervalMs = 1 * 60 * 1000) {
        this.resources = [];
        this.tools = [];
        this.refreshInterval = null;
        this.lastRefresh = 0;
        this.mcp = mcp;
        this.refreshIntervalMs = refreshIntervalMs;
    }
    async initialize() {
        await this.refresh();
        this.refreshInterval = setInterval(() => {
            this.refresh().catch(err => {
                console.error('Resource manager refresh failed:', err);
            });
        }, this.refreshIntervalMs);
    }
    async refresh() {
        try {
            // Refresh tools
            const toolsResult = await this.mcp.listTools();
            this.tools = (toolsResult?.tools || []).map((t) => ({
                name: t.name,
                description: t.description || '',
                inputSchema: t.inputSchema || {},
            }));
            // Refresh resources
            const resourcesResult = await this.mcp.listResources();
            this.resources = (resourcesResult?.resources || []).filter((r) => {
                const uri = r.uri || '';
                // Only include "all" resources (list endpoints)
                return uri.endsWith('://all') || uri.includes('://all/');
            });
            this.lastRefresh = Date.now();
            console.log(`Resource manager refreshed: ${this.tools.length} tools, ${this.resources.length} resources`);
        }
        catch (error) {
            console.error('Failed to refresh resource manager:', error);
            throw error;
        }
    }
    getResources() {
        return [...this.resources];
    }
    getTools() {
        return [...this.tools];
    }
    getResourceByType(type) {
        return this.resources.find(r => {
            const uri = r.uri || '';
            const match = uri.match(/^([^:]+):/);
            return match && match[1] === type;
        });
    }
    getResourceUri(type) {
        const resource = this.getResourceByType(type);
        return resource?.uri;
    }
    async ensureFresh() {
        const now = Date.now();
        if (now - this.lastRefresh > this.refreshIntervalMs) {
            await this.refresh();
        }
    }
    destroy() {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
    }
}
exports.ResourceManager = ResourceManager;
