"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Router = void 0;
class Router {
    constructor(toolCache, planner, contextProvider, executor) {
        this.toolCache = toolCache;
        this.planner = planner;
        this.contextProvider = contextProvider;
        this.executor = executor;
    }
    async route(message, userId, context = {}, conversationHistory = []) {
        // Try fast path first - dynamically built from tool examples
        const fastPathMatch = this.tryFastPath(message);
        if (fastPathMatch) {
            return {
                calls: [
                    {
                        tool: fastPathMatch.tool,
                        args: fastPathMatch.args,
                    },
                ],
                needs_confirmation: false,
                reasoning: `Fast path match for ${fastPathMatch.tool}`,
            };
        }
        // Fall back to planner
        return await this.planner.plan(message, userId, context, conversationHistory);
    }
    tryFastPath(message) {
        const lowerMessage = message.toLowerCase().trim();
        const allTools = this.toolCache.getAllTools();
        const matches = [];
        // Document-related keywords - only match send_document if these are present
        const documentKeywords = ['document', 'doc', 'checklist', 'package', 'file', 'pdf', 'submittal', 'ecp'];
        const isDocumentRequest = documentKeywords.some(kw => lowerMessage.includes(kw));
        // Try to match against tool examples first (most specific)
        for (const tool of allTools) {
            // Skip send_document if message doesn't mention documents
            if (tool.name === 'send_document' && !isDocumentRequest) {
                continue;
            }
            // Check examples for exact or similar matches
            for (const example of tool.examples) {
                const exampleQuery = example.query.toLowerCase();
                // Check if message contains key words from example
                const exampleWords = exampleQuery.split(/\s+/).filter(w => w.length > 2);
                const messageWords = lowerMessage.split(/\s+/);
                // Calculate similarity - if most key words match, it's likely a match
                const matchingWords = exampleWords.filter(ew => messageWords.some(mw => mw.includes(ew) || ew.includes(mw)));
                // Calculate confidence based on word overlap
                const confidence = exampleWords.length > 0
                    ? matchingWords.length / exampleWords.length
                    : 0;
                // If we have good word overlap, try to extract args
                if (matchingWords.length >= Math.min(2, exampleWords.length) && confidence > 0.5) {
                    const args = this.extractArgsFromMessage(message, tool, example.args);
                    if (args !== null) {
                        matches.push({
                            tool: tool.name,
                            args,
                            confidence: confidence,
                        });
                    }
                }
            }
            // Try matching by tool name keywords (more specific)
            const toolNameWords = tool.name.toLowerCase().split(/[_\s]+/).filter(w => w.length > 3);
            const nameMatches = toolNameWords.filter(word => lowerMessage.includes(word));
            if (nameMatches.length > 0) {
                // Skip send_document if message doesn't mention documents
                if (tool.name === 'send_document' && !isDocumentRequest) {
                    continue;
                }
                // Try to extract args based on tool schema
                const args = this.extractArgsFromMessage(message, tool, {});
                if (args !== null) {
                    // Higher confidence for more matching words
                    const confidence = 0.6 + (nameMatches.length / toolNameWords.length) * 0.2;
                    matches.push({
                        tool: tool.name,
                        args,
                        confidence: Math.min(confidence, 0.9),
                    });
                }
            }
            // Try matching by description keywords (less specific, lower priority)
            const description = tool.description.toLowerCase();
            const descWords = description.split(/\s+/).filter(w => w.length > 4);
            const descMatches = descWords.filter(word => lowerMessage.includes(word));
            if (descMatches.length > 0) {
                // Skip send_document if message doesn't mention documents
                if (tool.name === 'send_document' && !isDocumentRequest) {
                    continue;
                }
                const args = this.extractArgsFromMessage(message, tool, {});
                if (args !== null) {
                    const confidence = 0.5 + (descMatches.length / descWords.length) * 0.1;
                    matches.push({
                        tool: tool.name,
                        args,
                        confidence: Math.min(confidence, 0.7),
                    });
                }
            }
        }
        // Return the best match (highest confidence)
        if (matches.length === 0) {
            return null;
        }
        // Sort by confidence (highest first)
        matches.sort((a, b) => b.confidence - a.confidence);
        // Return the best match if confidence is high enough
        // Raised threshold to 0.75 to avoid false positives and let planner handle complex queries
        const bestMatch = matches[0];
        if (bestMatch.confidence >= 0.75) {
            return bestMatch;
        }
        return null;
    }
    extractArgsFromMessage(message, tool, exampleArgs) {
        const schema = tool.inputSchema || {};
        const properties = schema.properties || {};
        const args = {};
        // If we have example args, try to use them as defaults
        if (Object.keys(exampleArgs).length > 0) {
            Object.assign(args, exampleArgs);
        }
        // Try to extract values from message for each property
        for (const [propName, propSchema] of Object.entries(properties)) {
            // Skip if we already have a value from example
            if (args[propName] !== undefined) {
                continue;
            }
            const propType = propSchema.type || 'string';
            const propDesc = (propSchema.description || '').toLowerCase();
            // Try to extract value based on property name
            if (propType === 'string') {
                // Look for quoted strings
                const quotedMatch = message.match(new RegExp(`${propName}\\s*[:=]\\s*["']([^"']+)["']`, 'i'));
                if (quotedMatch) {
                    args[propName] = quotedMatch[1];
                    continue;
                }
                // Look for property name followed by value
                const propMatch = message.match(new RegExp(`${propName}\\s+(\\S+)`, 'i'));
                if (propMatch) {
                    args[propName] = propMatch[1];
                    continue;
                }
                // For query-like properties, try to extract the query part
                if (propName.toLowerCase().includes('query') || propName.toLowerCase().includes('search')) {
                    // Extract everything after common query keywords
                    const queryMatch = message.match(/(?:for|about|search|find|get|show|send|give)\s+(.+)/i);
                    if (queryMatch) {
                        args[propName] = queryMatch[1].trim();
                        continue;
                    }
                }
                // For ID-like properties, try to extract IDs
                if (propName.toLowerCase().includes('id') || propName.toLowerCase().includes('identifier')) {
                    const idMatch = message.match(/\b([a-z0-9_-]+)\b/i);
                    if (idMatch) {
                        args[propName] = idMatch[1];
                        continue;
                    }
                }
            }
            else if (propType === 'number') {
                const numMatch = message.match(new RegExp(`${propName}\\s*[:=]\\s*(\\d+)`, 'i'));
                if (numMatch) {
                    args[propName] = parseInt(numMatch[1], 10);
                    continue;
                }
                // Try to find any number in the message
                const anyNumMatch = message.match(/\b(\d+)\b/);
                if (anyNumMatch) {
                    args[propName] = parseInt(anyNumMatch[1], 10);
                    continue;
                }
            }
            else if (propType === 'boolean') {
                const boolMatch = message.match(new RegExp(`${propName}\\s*[:=]\\s*(true|false|yes|no)`, 'i'));
                if (boolMatch) {
                    args[propName] = ['true', 'yes'].includes(boolMatch[1].toLowerCase());
                    continue;
                }
            }
        }
        // If we have required properties, make sure they're all filled
        const required = schema.required || [];
        const hasAllRequired = required.every((prop) => args[prop] !== undefined);
        // If no required properties, or we have all required, return args
        if (required.length === 0 || hasAllRequired) {
            // Return null if we couldn't extract anything and there are required fields
            if (Object.keys(args).length === 0 && required.length > 0) {
                return null;
            }
            return args;
        }
        // If we have some args but not all required, still return what we have
        // The planner can handle missing args
        if (Object.keys(args).length > 0) {
            return args;
        }
        return null;
    }
    getExecutor() {
        return this.executor;
    }
}
exports.Router = Router;
