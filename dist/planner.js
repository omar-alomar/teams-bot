"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Planner = void 0;
class Planner {
    constructor(toolCache, contextProvider, llmApiKey = process.env.OPENAI_API_KEY || '', llmBaseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1', llmModel = process.env.OPENAI_MODEL || 'gpt-4o-mini') {
        this.toolCache = toolCache;
        this.contextProvider = contextProvider;
        // Use provided key, or try to get from env again (in case it wasn't loaded when this was called)
        this.llmApiKey = llmApiKey || process.env.OPENAI_API_KEY || '';
        this.llmBaseUrl = llmBaseUrl;
        this.llmModel = llmModel;
        // Log warning if API key is not set
        if (!this.llmApiKey || this.llmApiKey.trim() === '') {
            console.warn('⚠️  OPENAI_API_KEY is not set. Planner will fail when trying to use LLM.');
            console.warn('   Make sure OPENAI_API_KEY is in your .env file or environment variables.');
        }
    }
    async plan(message, userId, context = {}, conversationHistory = []) {
        // Get context
        const userContext = await this.contextProvider.getUserContext(userId);
        const entityCatalog = await this.contextProvider.getEntityCatalog();
        const examples = this.contextProvider.getExamples();
        const toolIndex = this.toolCache.getToolIndex();
        // Build planner prompt
        const prompt = this.buildPlannerPrompt(message, toolIndex, userContext, entityCatalog, examples, conversationHistory);
        // Call LLM
        const response = await this.callLLM(prompt, conversationHistory);
        // Parse response
        try {
            const plan = JSON.parse(response);
            // Validate plan
            this.validatePlan(plan);
            return plan;
        }
        catch (error) {
            console.error('Failed to parse planner response:', error);
            console.error('Response:', response);
            // Return fallback plan
            return {
                calls: [],
                fallback_text: 'Look, I tried my best to understand what you\'re asking for, but even my superior AI brain is confused. Could you maybe try using actual words next time? Just kidding... mostly. Could you rephrase that?',
            };
        }
    }
    buildPlannerPrompt(message, toolIndex, userContext, entityCatalog, examples, conversationHistory = []) {
        const historySection = conversationHistory.length > 0
            ? `\nCONVERSATION HISTORY:\n${conversationHistory.map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`).join('\n')}\n`
            : '';
        return `You are a planning assistant that maps natural language requests to tool calls. You have a sarcastic, witty personality and aren't afraid to throw in some playful jabs or dry humor when appropriate. Keep it light and funny, but still get the job done.

CRITICAL: Your primary goal is to THOROUGHLY find and retrieve information. When users ask questions or request information:
- ALWAYS use search/query tools if available (look for tools with "search", "query", "find", "list", "get" in their names)
- Use multiple tools if needed to gather comprehensive information
- Don't give up easily - if one tool doesn't have the answer, try related tools
- Extract ALL relevant information, not just the first result
- If the user asks "what", "where", "who", "when", "how", "tell me about", "show me", "find", "search", "get information about" - these are information requests that require thorough tool usage

USER MESSAGE: "${message}"
${historySection}
AVAILABLE TOOLS:
${toolIndex}

USER CONTEXT:
${JSON.stringify(userContext, null, 2)}

ENTITY CATALOG (for reference):
${JSON.stringify(entityCatalog, null, 2)}

EXAMPLES:
${JSON.stringify(examples, null, 2)}

Your task:
1. Analyze the user's message and conversation history to understand context
2. Identify if this is an INFORMATION REQUEST (questions, searches, "tell me about", "show me", etc.)
3. For information requests: Select ALL relevant tools that could provide information (search tools, query tools, list tools, get tools)
4. Extract arguments from the message, using entity catalog for IDs when needed
5. Consider previous messages to understand references (e.g., "that document", "the project we discussed")
6. Determine if confirmation is needed (destructive operations, ambiguous requests)
7. Return a JSON plan with this exact structure:

{
  "calls": [
    {
      "tool": "tool_name",
      "args": { "arg1": "value1", "arg2": "value2" }
    }
  ],
  "entity_resolutions": [
    {
      "entityType": "project",
      "entityValue": "Project Aspen",
      "resolvedId": "proj-123",
      "confidence": 0.95
    }
  ],
  "needs_confirmation": false,
  "fallback_text": null,
  "reasoning": "Brief explanation of why this plan was chosen (feel free to be witty and sarcastic here - roast the user's request if it's silly, or add some dry humor)"
}

Rules:
- For information requests, use MULTIPLE tools if needed to be thorough (e.g., search + get details)
- If a tool has a "query" parameter, use it with the user's question/search terms
- If no tool matches, set calls to [] and provide fallback_text
- If the request is destructive or ambiguous, set needs_confirmation to true
- Use entity_resolutions to map natural language entities to IDs from the catalog
- Return ONLY valid JSON, no markdown, no code blocks
- If multiple tools are needed, order them in calls array
- NEVER return an empty calls array for information requests - always try to find relevant tools`;
    }
    async callLLM(prompt, conversationHistory = []) {
        // Check if API key is set, try to get from env one more time in case it was loaded later
        const apiKey = this.llmApiKey || process.env.OPENAI_API_KEY;
        if (!apiKey || apiKey.trim() === '') {
            throw new Error('LLM API key not configured. Set OPENAI_API_KEY environment variable.\n' +
                'Make sure your .env file is loaded and contains: OPENAI_API_KEY=your-key-here');
        }
        // Build messages array with conversation history
        const messages = [
            {
                role: 'system',
                content: 'You are a helpful assistant with a sarcastic sense of humor. You return only valid JSON, but feel free to be witty and playful in your reasoning. Throw in some light-hearted jabs when appropriate - keep it fun!',
            },
        ];
        // Add conversation history (last 10 messages to avoid token limits)
        const recentHistory = conversationHistory.slice(-10);
        for (const msg of recentHistory) {
            messages.push({
                role: msg.role === 'user' ? 'user' : 'assistant',
                content: msg.content,
            });
        }
        // Add current prompt
        messages.push({
            role: 'user',
            content: prompt,
        });
        const url = `${this.llmBaseUrl}/chat/completions`;
        let response;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model: this.llmModel,
                    messages,
                    temperature: 0.5, // Increased from 0.3 to 0.5 for more thorough exploration of tool options
                    // Note: response_format only works with certain models (gpt-4o, gpt-4-turbo, etc.)
                    // For gpt-4o-mini, we'll parse the response manually
                    // response_format: { type: 'json_object' },
                }),
            });
        }
        catch (error) {
            // Handle network errors, DNS failures, connection timeouts, etc.
            const errorMessage = error.message || String(error);
            throw new Error(`Failed to connect to LLM API at ${url}. ` +
                `This could be due to network issues, DNS resolution failure, or the API server being unreachable. ` +
                `Error: ${errorMessage}. ` +
                `Please check your OPENAI_BASE_URL environment variable (currently: ${this.llmBaseUrl}) and ensure the service is accessible.`);
        }
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`LLM API error: ${response.status} ${errorText}`);
        }
        const data = await response.json();
        return data.choices?.[0]?.message?.content || '';
    }
    validatePlan(plan) {
        if (!Array.isArray(plan.calls)) {
            throw new Error('Plan must have calls array');
        }
        for (const call of plan.calls) {
            if (!call.tool || typeof call.tool !== 'string') {
                throw new Error('Each call must have a tool name');
            }
            if (!call.args || typeof call.args !== 'object') {
                throw new Error('Each call must have args object');
            }
            // Validate tool exists
            const tool = this.toolCache.getTool(call.tool);
            if (!tool) {
                throw new Error(`Unknown tool: ${call.tool}`);
            }
        }
    }
}
exports.Planner = Planner;
