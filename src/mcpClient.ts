// mcpClient.ts
export type JsonRpc = {
    jsonrpc: "2.0";
    id?: number;
    method?: string;
    params?: any;
    result?: any;
    error?: { code: number; message: string; data?: any };
  };
  
  export class McpHttpClient {
    private base: string;
    private sid: string | null = null;
    private id = 1;
    private initialized = false;
  
    constructor(base: string) {
      this.base = base.replace(/\/+$/, "");
    }
  
    private getSessionIdFromHeaders(headers: Headers): string | null {
      // Try different case variations
      return headers.get("mcp-session-id") || 
             headers.get("Mcp-Session-Id") || 
             headers.get("MCP-Session-ID") ||
             null;
    }

    private parseSSEResponse(text: string): string | null {
      // Check if response is SSE format
      if (text.includes("event:") || text.includes("data:")) {
        // Collect all data lines (SSE can have multiple data: lines)
        const lines = text.split("\n");
        const dataLines: string[] = [];
        let inDataBlock = false;
        let currentData = "";
        
        for (const line of lines) {
          // Handle "data: {...}" format
          if (line.startsWith("data: ")) {
            inDataBlock = true;
            currentData += line.substring(6); // Remove "data: " prefix
          } 
          // Handle "data:{...}" format (no space)
          else if (line.startsWith("data:")) {
            inDataBlock = true;
            currentData += line.substring(5); // Remove "data:" prefix
          }
          // Handle continuation lines (empty lines or lines that continue JSON)
          else if (inDataBlock) {
            if (line.trim() === "") {
              // Empty line ends the data block
              if (currentData.trim()) {
                dataLines.push(currentData.trim());
                currentData = "";
              }
              inDataBlock = false;
            } else {
              // Continuation of JSON (multiline JSON)
              currentData += "\n" + line;
            }
          }
        }
        
        // Add any remaining data
        if (currentData.trim()) {
          dataLines.push(currentData.trim());
        }
        
        // If we found data lines, combine them (SSE can split large JSON)
        if (dataLines.length > 0) {
          // Try to combine all data lines as one JSON
          const combined = dataLines.join("\n");
          // Try to parse as JSON to see if it's complete
          try {
            JSON.parse(combined);
            return combined;
          } catch {
            // If not valid JSON, try each line individually
            for (const data of dataLines) {
              try {
                JSON.parse(data);
                return data;
              } catch {
                // Not this one, continue
              }
            }
          }
        }
        
        // Fallback: Try regex to find JSON after "data:" (handles multiline JSON)
        // Use greedy matching to capture full JSON object
        const jsonMatch = text.match(/data:\s*(\{[\s\S]*\})/);
        if (jsonMatch && jsonMatch[1]) {
          try {
            JSON.parse(jsonMatch[1]);
            return jsonMatch[1].trim();
          } catch {
            // Invalid JSON, try next approach
          }
        }
        
        // Last resort: Try to find any complete JSON object
        // This handles cases where JSON might be split across multiple SSE events
        const jsonMatch2 = text.match(/(\{[\s\S]*\})/);
        if (jsonMatch2) {
          return jsonMatch2[1].trim();
        }
      }
      return null;
    }
  
    private async post(body: { method?: string; params?: any }, signal?: AbortSignal) {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      };
      
      // Add session ID header ONLY if we already have one (not for initialize request)
      if (this.sid && body.method !== "initialize") {
        headers["mcp-session-id"] = this.sid;
      }
  
      const requestBody = JSON.stringify({ jsonrpc: "2.0", id: this.id++, ...body });
      
      const res = await fetch(this.base, {
        method: "POST",
        headers,
        body: requestBody,
        signal,
      });
  
      // Capture session id from response header (server generates it on initialize)
      if (!this.sid) {
        const sid = this.getSessionIdFromHeaders(res.headers);
        if (sid) {
          this.sid = sid;
        }
      }
  
      // Parse response (could be JSON or SSE format)
      const text = await res.text();
      
      // Check HTTP status after reading body
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
      }
      
      if (!text) {
        // Empty response might be OK for notifications
        return null;
      }
  
      // Try to parse as SSE first, then fall back to plain JSON
      let jsonText = this.parseSSEResponse(text);
      if (!jsonText) {
        jsonText = text;
      }
  
      let json: JsonRpc;
      try {
        json = JSON.parse(jsonText) as JsonRpc;
      } catch (e) {
        throw new Error(`Invalid JSON response: ${text.substring(0, 200)}`);
      }
  
      if (json.error) {
        const errorMsg = `${json.error.code}: ${json.error.message}${json.error.data ? ` - ${JSON.stringify(json.error.data)}` : ''}`;
        throw new Error(errorMsg);
      }
      
      return json.result;
    }
  
    private async postNotification(body: { method?: string }, signal?: AbortSignal) {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      };
      
      // Always include session ID for notifications (after initialize)
      if (!this.sid) {
        throw new Error("Cannot send notification: no session ID");
      }
      
      headers["mcp-session-id"] = this.sid;
  
      const res = await fetch(this.base, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", ...body }),
        signal,
      });
  
      // Check HTTP status
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status} on notification: ${text}`);
      }
  
      // Notifications don't return a response body, but we might get session ID in headers
      if (!this.sid) {
        const sid = this.getSessionIdFromHeaders(res.headers);
        if (sid) this.sid = sid;
      }
  
      return null;
    }
  
    async init(clientInfo = { name: "teams-bot", version: "1.0.0" }) {
      if (this.initialized && this.sid) return this.sid;
      
      // Reset state for retry
      this.sid = null;
      this.initialized = false;
      
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10_000);
      try {
        // Step 1: Send initialize request WITHOUT session ID header
        // Server will generate session ID and return it in response header
        // The initialize request must match what isInitializeRequest expects
        const initParams = {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: {
            name: clientInfo.name || "teams-bot",
            version: clientInfo.version || "1.0.0",
          },
        };
        
        const result = await this.post({ 
          method: "initialize", 
          params: initParams 
        }, ctrl.signal);
        
        // Step 2: Verify we got a session ID
        if (!this.sid) {
          throw new Error("Session ID not received from server after initialize. Check server response headers.");
        }
        
        // Step 3: Send initialized notification WITH session ID
        await this.postNotification({ method: "initialized" }, ctrl.signal);
        
        this.initialized = true;
        return this.sid!;
      } catch (error: any) {
        // Reset on error
        this.sid = null;
        this.initialized = false;
        throw error;
      } finally {
        clearTimeout(t);
      }
    }
  
    // Convenience calls
    listResources() { return this.post({ method: "resources/list" }); }
    readResource(uri: string) { return this.post({ method: "resources/read", params: { uri } }); }
    listTools() { return this.post({ method: "tools/list" }); }
    callTool(name: string, args: any = {}) { return this.post({ method: "tools/call", params: { name, arguments: args } }); }
  }
  