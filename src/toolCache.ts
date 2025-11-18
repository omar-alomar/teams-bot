import { McpHttpClient } from './mcpClient';

export interface ToolMetadata {
  name: string;
  description: string;
  inputSchema: any; // JSON schema
  examples: Array<{ query: string; args: any }>;
  safety: {
    read: boolean;
    write: boolean;
    destructive: boolean;
  };
}

export class ToolCache {
  private tools: Map<string, ToolMetadata> = new Map();
  private mcp: McpHttpClient;
  private refreshInterval: NodeJS.Timeout | null = null;
  private refreshIntervalMs: number;

  constructor(mcp: McpHttpClient, refreshIntervalMs: number = 5 * 60 * 1000) {
    this.mcp = mcp;
    this.refreshIntervalMs = refreshIntervalMs;
  }

  async initialize(): Promise<void> {
    await this.refresh();
    // Set up periodic refresh
    this.refreshInterval = setInterval(() => {
      this.refresh().catch(err => {
        console.error('Tool cache refresh failed:', err);
      });
    }, this.refreshIntervalMs);
  }

  async refresh(): Promise<void> {
    try {
      const result = await this.mcp.listTools();
      const toolList = result?.tools || [];

      this.tools.clear();

      for (const tool of toolList) {
        const metadata: ToolMetadata = {
          name: tool.name,
          description: tool.description || '',
          inputSchema: tool.inputSchema || {},
          examples: this.generateExamples(tool.name, tool.description || '', tool.inputSchema || {}),
          safety: this.analyzeSafety(tool.name, tool.description || '', tool.inputSchema || {}),
        };

        this.tools.set(tool.name, metadata);
      }

      console.log(`Tool cache refreshed: ${this.tools.size} tools`);
    } catch (error) {
      console.error('Failed to refresh tool cache:', error);
      throw error;
    }
  }

  private generateExamples(toolName: string, description: string, schema: any): Array<{ query: string; args: any }> {
    const examples: Array<{ query: string; args: any }> = [];

    // Generate examples based on tool name and common patterns
    if (toolName === 'send_document') {
      examples.push(
        { query: 'send me the ecp checklist', args: { query: 'ecp checklist' } },
        { query: 'where is the submittal package', args: { query: 'submittal package' } },
        { query: 'get me the project deadline document', args: { query: 'project deadline' } }
      );
    } else if (toolName.includes('project') || toolName.includes('project')) {
      examples.push(
        { query: 'show me project details', args: {} },
        { query: 'what projects do we have', args: {} }
      );
    } else if (toolName.includes('user') || toolName.includes('users')) {
      examples.push(
        { query: 'list all users', args: {} },
        { query: 'who are the team members', args: {} }
      );
    } else if (toolName.includes('document') || toolName.includes('doc')) {
      examples.push(
        { query: 'get document by id', args: { id: 'example-id' } },
        { query: 'find document', args: { query: 'example' } }
      );
    } else if (toolName.includes('client')) {
      examples.push(
        { query: 'get client information', args: {} },
        { query: 'show me client details', args: {} }
      );
    } else if (toolName.includes('phone') || toolName.includes('phone_number')) {
      examples.push(
        { query: 'get phone number for client', args: {} },
        { query: 'what is the phone number', args: {} },
        { query: 'send me phone number', args: {} },
        { query: 'send me burkards number', args: {} },
        { query: 'get burkards phone', args: {} },
        { query: 'phone number', args: {} }
      );
    } else if (toolName.includes('email')) {
      examples.push(
        { query: 'get email address for client', args: {} },
        { query: 'what is the email', args: {} },
        { query: 'send me email', args: {} },
        { query: 'send me burkards email', args: {} },
        { query: 'get bruce harveys email', args: {} },
        { query: 'email address', args: {} }
      );
    } else if (toolName.includes('address')) {
      examples.push(
        { query: 'get address for client', args: {} },
        { query: 'what is the address', args: {} },
        { query: 'send me address', args: {} },
        { query: 'address', args: {} }
      );
    }

    // Add generic examples if schema has properties
    if (schema.properties && Object.keys(schema.properties).length > 0) {
      const props = schema.properties;
      const exampleArgs: any = {};
      for (const [key, prop] of Object.entries(props) as [string, any][]) {
        if (prop.type === 'string') {
          exampleArgs[key] = `example-${key}`;
        } else if (prop.type === 'number') {
          exampleArgs[key] = 123;
        } else if (prop.type === 'boolean') {
          exampleArgs[key] = true;
        }
      }
      if (Object.keys(exampleArgs).length > 0) {
        examples.push({
          query: `use ${toolName} with ${Object.keys(exampleArgs).join(' and ')}`,
          args: exampleArgs,
        });
      }
    }

    return examples;
  }

  private analyzeSafety(toolName: string, description: string, schema: any): {
    read: boolean;
    write: boolean;
    destructive: boolean;
  } {
    const lowerName = toolName.toLowerCase();
    const lowerDesc = description.toLowerCase();

    // Check for destructive operations
    const destructiveKeywords = ['delete', 'remove', 'destroy', 'drop', 'clear', 'truncate', 'cancel'];
    const destructive = destructiveKeywords.some(kw => 
      lowerName.includes(kw) || lowerDesc.includes(kw)
    );

    // Check for write operations
    const writeKeywords = ['create', 'update', 'edit', 'modify', 'add', 'insert', 'save', 'set', 'post', 'put', 'patch'];
    const write = writeKeywords.some(kw => 
      lowerName.includes(kw) || lowerDesc.includes(kw)
    ) || destructive;

    // Default to read if not write or destructive
    const read = !write && !destructive;

    return { read, write, destructive };
  }

  getTool(name: string): ToolMetadata | undefined {
    return this.tools.get(name);
  }

  getAllTools(): ToolMetadata[] {
    return Array.from(this.tools.values());
  }

  getToolIndex(): string {
    // Create a compact tool index for the planner
    const toolList = this.getAllTools().map(tool => ({
      name: tool.name,
      description: tool.description,
      args: this.summarizeSchema(tool.inputSchema),
      safety: tool.safety,
      examples: tool.examples.slice(0, 2), // Limit examples
    }));

    return JSON.stringify(toolList, null, 2);
  }

  private summarizeSchema(schema: any): string {
    if (!schema.properties) return '{}';
    const props = Object.keys(schema.properties).map(key => {
      const prop = schema.properties[key];
      return `${key}: ${prop.type || 'any'}${prop.description ? ` (${prop.description})` : ''}`;
    });
    return `{ ${props.join(', ')} }`;
  }

  destroy(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }
}

