"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PlanExecutor = void 0;
class PlanExecutor {
    constructor(mcp, toolCache) {
        this.mcp = mcp;
        this.toolCache = toolCache;
    }
    setStreamHandler(handler) {
        this.onStream = handler;
    }
    async execute(plan, userId, context) {
        const result = {
            success: true,
            results: [],
            errors: [],
            needsConfirmation: plan.needs_confirmation || false,
        };
        // Check if confirmation is needed
        if (plan.needs_confirmation) {
            // This should be handled by the caller
            return result;
        }
        // Execute each call in sequence
        for (const call of plan.calls) {
            try {
                await this.stream(`Executing ${call.tool}...`);
                // Validate call
                const validationError = this.validateCall(call);
                if (validationError) {
                    result.errors.push({ call, error: validationError });
                    result.success = false;
                    continue;
                }
                // Execute tool
                const toolResult = await this.executeCall(call);
                result.results.push(toolResult);
                await this.stream(`✓ Completed ${call.tool}`);
            }
            catch (error) {
                result.errors.push({ call, error: error.message || String(error) });
                result.success = false;
            }
        }
        return result;
    }
    validateCall(call) {
        const tool = this.toolCache.getTool(call.tool);
        if (!tool) {
            return `Unknown tool: ${call.tool}`;
        }
        // Validate args against schema
        const schema = tool.inputSchema;
        if (!schema || !schema.properties) {
            return null; // No schema to validate against
        }
        const required = schema.required || [];
        for (const prop of required) {
            if (!(prop in call.args)) {
                return `Missing required argument: ${prop}`;
            }
        }
        // Type validation
        for (const [key, value] of Object.entries(call.args)) {
            const prop = schema.properties[key];
            if (!prop) {
                // Unknown property, but might be okay
                continue;
            }
            if (prop.type === 'string' && typeof value !== 'string') {
                return `Invalid type for ${key}: expected string, got ${typeof value}`;
            }
            if (prop.type === 'number' && typeof value !== 'number') {
                return `Invalid type for ${key}: expected number, got ${typeof value}`;
            }
            if (prop.type === 'boolean' && typeof value !== 'boolean') {
                return `Invalid type for ${key}: expected boolean, got ${typeof value}`;
            }
        }
        return null;
    }
    async executeCall(call) {
        try {
            const result = await this.mcp.callTool(call.tool, call.args);
            return result;
        }
        catch (error) {
            throw new Error(`Tool execution failed: ${error.message || String(error)}`);
        }
    }
    async stream(message) {
        if (this.onStream) {
            await this.onStream(message);
        }
    }
    async requestRepair(originalPlan, error, userId, context) {
        // Return a simple fallback - repair planning would require planner access
        // which is better handled at the router level
        return {
            calls: [],
            fallback_text: `I encountered an error: ${error}. Could you rephrase your request?`,
        };
    }
}
exports.PlanExecutor = PlanExecutor;
