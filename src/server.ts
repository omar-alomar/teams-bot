import 'dotenv/config';
import http, { IncomingMessage, ServerResponse } from 'http';
import {
  ActivityHandler,
  CardFactory,
  CloudAdapter,
  ConfigurationServiceClientCredentialFactory,
  createBotFrameworkAuthenticationFromConfiguration,
  TurnContext,
  WebRequest,
  WebResponse,
} from 'botbuilder';
import { McpHttpClient } from "./mcpClient";
import { ToolCache } from "./toolCache";
import { Planner } from "./planner";
import { ContextProvider } from "./contextProvider";
import { Router } from "./router";
import { PlanExecutor } from "./planExecutor";
import { ResultFormatter } from "./resultFormatter";
import { ConversationHistory } from "./conversationHistory";
import { ResourceManager } from "./resourceManager";

// create reusable client (one session)
const mcp = new McpHttpClient(process.env.MCP_BASE ?? "http://mcp:8080/mcp");

// Initialize resource manager (discovers tools and resources automatically)
const resourceManager = new ResourceManager(mcp, 1 * 60 * 1000); // Refresh every 1 minute

// Initialize planner layer components
const toolCache = new ToolCache(mcp, 1 * 60 * 1000); // Refresh every 1 minute for faster updates
const contextProvider = new ContextProvider(mcp, 1 * 60 * 1000); // Refresh every 1 minute for faster updates
const planner = new Planner(
  toolCache,
  contextProvider,
  process.env.OPENAI_API_KEY,
  process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  process.env.OPENAI_MODEL || 'gpt-4o-mini'
);
const executor = new PlanExecutor(mcp, toolCache);
const resultFormatter = new ResultFormatter(process.env.FILES_BASE_URL || 'https://files.mba-eng.com');
const router = new Router(toolCache, planner, contextProvider, executor);
const conversationHistory = new ConversationHistory(
  parseInt(process.env.CONVERSATION_HISTORY_MAX_MESSAGES || '20'),
  parseInt(process.env.CONVERSATION_HISTORY_MAX_AGE_MS || String(24 * 60 * 60 * 1000))
);

// Initialize planner layer on startup
(async () => {
  try {
    await mcp.init();
    await resourceManager.initialize();
    await toolCache.initialize();
    await contextProvider.initialize();
    console.log('Planner layer initialized successfully');
  } catch (error) {
    console.error('Failed to initialize planner layer:', error);
  }
})();

// ---------- ENV ----------
const PORT = Number(process.env.PORT) || 3978;
const APP_ID = process.env.MS_APP_ID?.trim();
const APP_PASSWORD = process.env.MS_APP_PASSWORD?.trim();
const APP_TENANT = process.env.MS_TENANT_ID?.trim() || undefined;   // required for SingleTenant
const APP_TYPE = (process.env.MS_APP_TYPE?.trim() || 'SingleTenant') as 'SingleTenant' | 'MultiTenant';

// Validate required env vars
if (!APP_ID) {
  throw new Error('MS_APP_ID is required');
}
if (!APP_PASSWORD) {
  throw new Error('MS_APP_PASSWORD is required');
}

// Validate configuration
if (APP_TYPE === 'SingleTenant' && !APP_TENANT) {
  throw new Error(
    'MS_TENANT_ID is required for SingleTenant mode. ' +
    'Please set MS_TENANT_ID in your .env file. ' +
    `You can find your tenant ID in the 'x-ms-tenant-id' header of incoming Teams requests.`
  );
}

// ---------- ADAPTER (tenant-aware) ----------
const credFactoryConfig: {
  MicrosoftAppId: string;
  MicrosoftAppPassword: string;
  MicrosoftAppType: 'SingleTenant' | 'MultiTenant';
  MicrosoftAppTenantId?: string;
} = {
  MicrosoftAppId: APP_ID!,
  MicrosoftAppPassword: APP_PASSWORD!,
  MicrosoftAppType: APP_TYPE,
};

// Include tenant ID (required for SingleTenant, optional for MultiTenant)
if (APP_TENANT) {
  credFactoryConfig.MicrosoftAppTenantId = APP_TENANT;
}

const credFactory = new ConfigurationServiceClientCredentialFactory(credFactoryConfig);
const bfa = createBotFrameworkAuthenticationFromConfiguration(null, credFactory);
const adapter = new CloudAdapter(bfa);

// ---------- BOT ----------
const bot = new ActivityHandler();
bot.onMessage(async (context: TurnContext, next) => {
  // Handle button clicks from adaptive card
  const buttonCommand = context.activity.value?.command;
  let txt = (context.activity.text || '').trim();
  
  // If button was clicked, construct command from button data
  if (buttonCommand) {
    const inputId = context.activity.value?.inputId;
    if (inputId) {
      // Parameterized command - get value from input field
      // Input field values are in context.activity.value with keys matching the input id
      const inputValue = (context.activity.value[inputId] || '').trim();
      if (inputValue) {
        txt = `${buttonCommand} ${inputValue}`;
      } else {
        // Empty input - show usage
        if (buttonCommand === "/document") {
          await context.sendActivity("Usage: Please enter a document ID");
        } else if (buttonCommand === "/senddoc") {
          await context.sendActivity("Usage: Please enter a search query");
        }
        return;
      }
    } else {
      // Simple command without parameters
      txt = buttonCommand;
    }
  }

  // Skip empty messages
  if (!txt) {
    await next();
    return;
  }

  // Ensure MCP session
  try {
    await mcp.init();
  } catch (e: any) {
    await context.sendActivity(`MCP init failed: ${e.message}`);
    return;
  }

  // Get user ID
  const userId = context.activity.from?.id || context.activity.from?.aadObjectId || 'unknown';
  const userName = context.activity.from?.name || 'User';

  // Handle confirmation responses
  if (context.activity.value?.confirm !== undefined) {
    await handleConfirmation(context, userId, userName);
    return;
  }

  // Handle legacy commands (for backward compatibility)
  if (txt.startsWith('/')) {
    await handleLegacyCommand(context, txt);
    return;
  }

  // Add user message to conversation history
  conversationHistory.addMessage(userId, 'user', txt);

  // Ensure tools are fresh before processing
  await resourceManager.ensureFresh();
  await toolCache.refresh();

  // Use router to handle natural language
  try {
    await handleNaturalLanguage(context, txt, userId, userName);
  } catch (error: any) {
    console.error('Error handling message:', error);
    const errorMessage = `❌ Error: ${error.message || 'Unknown error occurred'}`;
    conversationHistory.addMessage(userId, 'assistant', errorMessage);
    await context.sendActivity(errorMessage);
  }
});

async function handleNaturalLanguage(
  context: TurnContext,
  message: string,
  userId: string,
  userName: string
): Promise<void> {
  // Get conversation history for this user
  const history = conversationHistory.getHistory(userId);

  // Set up streaming handler
  const executor = router.getExecutor();
  executor.setStreamHandler(async (streamMessage: string) => {
    await context.sendActivity(streamMessage);
  });

  // Route message with conversation history
  const plan = await router.route(message, userId, { userName }, history);

  // Handle fallback
  if (plan.fallback_text) {
    conversationHistory.addMessage(userId, 'assistant', plan.fallback_text);
    await context.sendActivity(plan.fallback_text);
    return;
  }

  // Handle confirmation needed
  if (plan.needs_confirmation) {
    const confirmCard = CardFactory.adaptiveCard({
      type: 'AdaptiveCard',
      version: '1.4',
      body: [
        {
          type: 'TextBlock',
          text: '⚠️ Confirmation Required',
          size: 'Large',
          weight: 'Bolder',
          wrap: true,
        },
        {
          type: 'TextBlock',
          text: plan.reasoning || 'This action may be destructive or ambiguous. Do you want to proceed?',
          wrap: true,
          spacing: 'Medium',
        },
        {
          type: 'TextBlock',
          text: `**Planned actions:**\n${plan.calls.map(c => `- ${c.tool}(${JSON.stringify(c.args)})`).join('\n')}`,
          wrap: true,
          spacing: 'Small',
        },
      ],
      actions: [
        {
          type: 'Action.Submit',
          title: '✅ Confirm',
          data: { confirm: true, plan: JSON.stringify(plan) },
        },
        {
          type: 'Action.Submit',
          title: '❌ Cancel',
          data: { confirm: false },
        },
      ],
    });

    await context.sendActivity({
      attachments: [confirmCard],
    });
    return;
  }

  // Execute plan
  await executePlan(context, plan, userId, userName, history);
}

async function handleConfirmation(
  context: TurnContext,
  userId: string,
  userName: string
): Promise<void> {
  const confirm = context.activity.value?.confirm;
  const planJson = context.activity.value?.plan;

  if (!confirm) {
    const cancelMessage = '❌ Action cancelled.';
    conversationHistory.addMessage(userId, 'assistant', cancelMessage);
    await context.sendActivity(cancelMessage);
    return;
  }

  if (!planJson) {
    await context.sendActivity('❌ Error: Plan data missing.');
    return;
  }

  try {
    const plan = JSON.parse(planJson);
    const history = conversationHistory.getHistory(userId);
    await executePlan(context, plan, userId, userName, history);
  } catch (error: any) {
    console.error('Error executing confirmed plan:', error);
    const errorMessage = `❌ Error executing plan: ${error.message || 'Unknown error'}`;
    conversationHistory.addMessage(userId, 'assistant', errorMessage);
    await context.sendActivity(errorMessage);
  }
}

async function executePlan(
  context: TurnContext,
  plan: any,
  userId: string,
  userName: string,
  conversationHistoryMessages: any[] = []
): Promise<void> {
  // Set up streaming handler
  const executor = router.getExecutor();
  executor.setStreamHandler(async (streamMessage: string) => {
    await context.sendActivity(streamMessage);
  });

  // Execute plan
  const executionResult = await executor.execute(plan, userId, { userName });

  // Handle errors
  if (!executionResult.success && executionResult.errors.length > 0) {
    const errorMessages = executionResult.errors.map(e => `- ${e.call.tool}: ${e.error}`).join('\n');
    const errorMessage = `❌ Execution failed:\n${errorMessages}`;
    conversationHistory.addMessage(userId, 'assistant', errorMessage);
    await context.sendActivity(errorMessage);
    
    // Try to get repair plan
    if (executionResult.errors.length > 0) {
      const repairPlan = await executor.requestRepair(plan, executionResult.errors[0].error, userId, { userName });
      if (repairPlan.fallback_text) {
        conversationHistory.addMessage(userId, 'assistant', repairPlan.fallback_text);
        await context.sendActivity(repairPlan.fallback_text);
      }
    }
    return;
  }

  // Format and send results
  let responseText = '';
  for (const result of executionResult.results) {
    const formatted = await resultFormatter.format(result, plan.calls[0]?.tool || 'unknown');
    
    if (formatted.text) {
      responseText += formatted.text + '\n';
      await context.sendActivity(formatted.text);
    }
    
    if (formatted.attachments && formatted.attachments.length > 0) {
      await context.sendActivity({
        attachments: formatted.attachments,
      });
    }
  }

  // If no results but execution succeeded
  if (executionResult.results.length === 0) {
    const successMessage = '✅ Completed successfully (no output)';
    responseText = successMessage;
    await context.sendActivity(successMessage);
  }

  // Add assistant response to conversation history
  if (responseText.trim()) {
    conversationHistory.addMessage(userId, 'assistant', responseText.trim());
  }
}

async function handleToolResult(context: TurnContext, result: any, toolName: string): Promise<void> {
  // Handle the tool response - MCP tools typically return content array
  if (result?.content && Array.isArray(result.content)) {
    for (const item of result.content) {
      if (item.type === "blob") {
        // Handle blob (base64) response
        const fileData = Buffer.from(item.data, 'base64');
        const contentType = item.mimeType || 'application/pdf';
        const fileName = item.name || `result_${Date.now()}.pdf`;
        
        const attachment = {
          contentType: contentType,
          contentUrl: `data:${contentType};base64,${fileData.toString('base64')}`,
          name: fileName,
        };
        
        await context.sendActivity({
          attachments: [attachment],
          text: `📄 Result from ${toolName}: ${fileName}`,
        });
      } else if (item.type === "text") {
        const text = typeof item.text === 'string' ? item.text : JSON.stringify(item.text);
        try {
          const parsed = JSON.parse(text);
          if (parsed.downloadUrl && parsed.filename) {
            // Create adaptive card with download button
            const card = CardFactory.adaptiveCard({
              type: "AdaptiveCard",
              version: "1.4",
              body: [
                {
                  type: "TextBlock",
                  text: parsed.message || `Result from ${toolName}: ${parsed.filename}`,
                  size: "Medium",
                  weight: "Bolder",
                  wrap: true
                },
                {
                  type: "TextBlock",
                  text: `**Name:** ${parsed.name || parsed.filename}`,
                  wrap: true,
                  spacing: "Small"
                }
              ],
              actions: [
                {
                  type: "Action.OpenUrl",
                  title: "Download",
                  url: parsed.downloadUrl
                }
              ]
            });
            
            await context.sendActivity({
              attachments: [card]
            });
          } else {
            await context.sendActivity(`📄 Result from ${toolName}:\n\`\`\`\n${text}\n\`\`\``);
          }
        } catch {
          await context.sendActivity(`📄 Result from ${toolName}:\n${text}`);
        }
      }
    }
  } else if (result?.text) {
    try {
      const parsed = JSON.parse(result.text);
      if (parsed.downloadUrl && parsed.filename) {
        const card = CardFactory.adaptiveCard({
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            {
              type: "TextBlock",
              text: parsed.message || `Result from ${toolName}: ${parsed.filename}`,
              size: "Medium",
              weight: "Bolder",
              wrap: true
            }
          ],
          actions: [
            {
              type: "Action.OpenUrl",
              title: "Download",
              url: parsed.downloadUrl
            }
          ]
        });
        
        await context.sendActivity({
          attachments: [card]
        });
      } else {
        await context.sendActivity(`📄 Result from ${toolName}:\n${result.text}`);
      }
    } catch {
      await context.sendActivity(`📄 Result from ${toolName}:\n${result.text}`);
    }
  } else {
    const resultStr = JSON.stringify(result, null, 2);
    const maxLength = 25000;
    if (resultStr.length > maxLength) {
      await context.sendActivity(`📄 Result from ${toolName} (showing first ${maxLength} chars):\n\`\`\`\n${resultStr.slice(0, maxLength)}\n\`\`\``);
      await context.sendActivity(`... (truncated ${resultStr.length - maxLength} more characters)`);
    } else {
      await context.sendActivity(`📄 Result from ${toolName}:\n\`\`\`\n${resultStr}\n\`\`\``);
    }
  }
}

async function buildCommandCard(): Promise<any> {
  // Send command selector as adaptive card - dynamically generated from discovered resources
  await resourceManager.ensureFresh();
  const resources = resourceManager.getResources();
  const tools = resourceManager.getTools();

  const resourceActions = resources.map(resource => {
    const uri = resource.uri || '';
    const match = uri.match(/^([^:]+):/);
    const resourceType = match ? match[1] : 'unknown';
    const emoji = getEmojiForResourceType(resourceType);
    const displayName = resourceType.charAt(0).toUpperCase() + resourceType.slice(1);
    
    return {
      type: "Action.Submit",
      title: `${emoji} /${resourceType} - List All ${displayName}`,
      data: { command: `/${resourceType}` }
    };
  });

  const toolActions = tools
    .filter(tool => {
      // Only show tools that have parameters (need input)
      const schema = tool.inputSchema || {};
      return schema.properties && Object.keys(schema.properties).length > 0;
    })
    .slice(0, 5) // Limit to 5 tools to avoid card size issues
    .map(tool => {
      const schema = tool.inputSchema || {};
      const props = schema.properties || {};
      const firstProp = Object.keys(props)[0];
      
      return {
        type: "Container",
        spacing: "Medium",
        items: [
          {
            type: "TextBlock",
            text: `🔧 ${tool.name}`,
            size: "Medium",
            weight: "Bolder",
            wrap: true
          },
          {
            type: "TextBlock",
            text: tool.description || '',
            size: "Small",
            wrap: true,
            spacing: "Small"
          },
          ...(firstProp ? [{
            type: "Input.Text",
            id: `tool_${tool.name}_${firstProp}`,
            placeholder: `Enter ${firstProp}...`,
            label: firstProp
          }] : []),
          {
            type: "ActionSet",
            spacing: "Small",
            actions: [{
              type: "Action.Submit",
              title: `Use ${tool.name}`,
              data: { 
                command: "tool",
                toolName: tool.name,
                inputId: firstProp ? `tool_${tool.name}_${firstProp}` : undefined
              }
            }]
          }
        ]
      };
    });

  const commandCard = CardFactory.adaptiveCard({
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: "Available Commands",
        size: "Large",
        weight: "Bolder",
        wrap: true
      },
      {
        type: "TextBlock",
        text: "Click a button to execute a command:",
        size: "Medium",
        wrap: true,
        spacing: "Small"
      },
      {
        type: "ActionSet",
        spacing: "Medium",
        actions: [
          {
            type: "Action.Submit",
            title: "🔍 /ping - Check MCP Status",
            data: { command: "/ping" }
          },
          ...resourceActions
        ]
      },
      ...(toolActions.length > 0 ? [
        {
          type: "TextBlock",
          text: "Available Tools:",
          size: "Medium",
          weight: "Bolder",
          wrap: true,
          spacing: "Large"
        },
        ...toolActions
      ] : [])
    ]
  });

  return commandCard;
}

async function handleLegacyCommand(context: TurnContext, txt: string): Promise<void> {
  // Ensure we have fresh resources
  await resourceManager.ensureFresh();

  if (txt === "/ping") {
    const resources = resourceManager.getResources();
    const tools = resourceManager.getTools();
    await context.sendActivity(`✅ MCP alive. ${resources.length} resources, ${tools.length} tools.`);
    return;
  }

  // Dynamic resource handler - handle any resource type
  const resourceMatch = txt.match(/^\/([a-z]+)$/i);
  if (resourceMatch) {
    const resourceType = resourceMatch[1].toLowerCase();
    const uri = resourceManager.getResourceUri(resourceType);
    
    if (uri) {
      try {
        const out = await mcp.readResource(uri);
        const body = out?.contents?.[0]?.text ?? "[]";
        const maxLength = 25000;
        const emoji = getEmojiForResourceType(resourceType);
        
        if (body.length > maxLength) {
          await context.sendActivity(`${emoji} ${resourceType.charAt(0).toUpperCase() + resourceType.slice(1)} (showing first ${maxLength} chars of ${body.length}):\n\`\`\`\n${body.slice(0, maxLength)}\n\`\`\``);
          await context.sendActivity(`... (truncated ${body.length - maxLength} more characters)`);
        } else {
          await context.sendActivity(`${emoji} ${resourceType.charAt(0).toUpperCase() + resourceType.slice(1)}:\n\`\`\`\n${body}\n\`\`\``);
        }
      } catch (e: any) {
        await context.sendActivity(`❌ Error reading ${resourceType}: ${e.message}`);
      }
      return;
    }
  }

  // Dynamic resource item handler - handle /resourceType itemId
  const itemMatch = txt.match(/^\/([a-z]+)\s+(.+)$/i);
  if (itemMatch) {
    const resourceType = itemMatch[1].toLowerCase();
    const itemId = itemMatch[2].trim();
    const uri = `${resourceType}://${itemId}`;
    
    try {
      const out = await mcp.readResource(uri);
      const body = out?.contents?.[0]?.text ?? "";
      const maxLength = 25000;
      const emoji = getEmojiForResourceType(resourceType);
      
      if (body.length > maxLength) {
        await context.sendActivity(`${emoji} ${resourceType.charAt(0).toUpperCase() + resourceType.slice(1)} ${itemId} (showing first ${maxLength} chars of ${body.length}):\n\`\`\`\n${body.slice(0, maxLength)}\n\`\`\``);
        await context.sendActivity(`... (truncated ${body.length - maxLength} more characters)`);
      } else {
        await context.sendActivity(`${emoji} ${resourceType.charAt(0).toUpperCase() + resourceType.slice(1)} ${itemId}:\n\`\`\`\n${body}\n\`\`\``);
      }
    } catch (e: any) {
      await context.sendActivity(`❌ Error reading ${resourceType} ${itemId}: ${e.message}`);
    }
    return;
  }

  // Handle tool calls from adaptive card
  if (context.activity.value?.command === "tool") {
    const toolName = context.activity.value?.toolName;
    const inputId = context.activity.value?.inputId;
    
    if (!toolName) {
      await context.sendActivity("❌ Error: Tool name missing");
      return;
    }

    const inputValue = inputId ? (context.activity.value[inputId] || '').trim() : '';
    
    try {
      // Build args from input
      const args: any = {};
      if (inputId && inputValue) {
        const propName = inputId.replace(`tool_${toolName}_`, '');
        args[propName] = inputValue;
      }

      const result = await mcp.callTool(toolName, args);
      await handleToolResult(context, result, toolName);
    } catch (e: any) {
      await context.sendActivity(`❌ Error calling tool ${toolName}: ${e.message}`);
    }
    return;
  }

  if (txt.startsWith("/senddoc ")) {
    const query = txt.substring("/senddoc ".length).trim();
    if (!query) {
      await context.sendActivity("Usage: `/senddoc <query>`\nExample: `/senddoc ecp ded checklist`");
      return;
    }
    try {
      const result = await mcp.callTool("send_document", { query });
      
      // Handle the tool response - MCP tools typically return content array
      if (result?.content && Array.isArray(result.content)) {
        for (const item of result.content) {
          if (item.type === "blob") {
            // Handle blob (base64) response
            const fileData = Buffer.from(item.data, 'base64');
            const contentType = item.mimeType || 'application/pdf';
            const fileName = item.name || `document_${Date.now()}.pdf`;
            
            const attachment = {
              contentType: contentType,
              contentUrl: `data:${contentType};base64,${fileData.toString('base64')}`,
              name: fileName,
            };
            
            await context.sendActivity({
              attachments: [attachment],
              text: `📄 Found: ${fileName}`,
            });
          } else if (item.type === "text") {
            // Text response - might be JSON describing the file or plain text
            const text = typeof item.text === 'string' ? item.text : JSON.stringify(item.text);
            try {
              const parsed = JSON.parse(text);
              // Check if it's a document response with downloadUrl
              if (parsed.downloadUrl && parsed.filename) {
                // Create adaptive card with download button
                const card = CardFactory.adaptiveCard({
                  type: "AdaptiveCard",
                  version: "1.4",
                  body: [
                    {
                      type: "TextBlock",
                      text: parsed.message || `Found document: ${parsed.filename}`,
                      size: "Medium",
                      weight: "Bolder",
                      wrap: true
                    },
                    {
                      type: "TextBlock",
                      text: `**Name:** ${parsed.name || parsed.filename}`,
                      wrap: true,
                      spacing: "Small"
                    },
                    ...(parsed.matchScore ? [{
                      type: "TextBlock",
                      text: `**Match Score:** ${parsed.matchScore}%`,
                      wrap: true,
                      spacing: "Small"
                    }] : [])
                  ],
                  actions: [
                    {
                      type: "Action.OpenUrl",
                      title: "Download Document",
                      url: parsed.downloadUrl
                    }
                  ]
                });
                
                await context.sendActivity({
                  attachments: [card]
                });
              } else if (parsed.data && parsed.filename) {
                // JSON with file data (base64)
                const fileData = Buffer.from(parsed.data, 'base64');
                const attachment = {
                  contentType: parsed.contentType || 'application/pdf',
                  contentUrl: `data:${parsed.contentType || 'application/pdf'};base64,${fileData.toString('base64')}`,
                  name: parsed.filename,
                };
                await context.sendActivity({
                  attachments: [attachment],
                  text: `📄 Found: ${parsed.filename}`,
                });
              } else {
                // Not a file format, just return the text
                await context.sendActivity(`📄 Document found:\n\`\`\`\n${text}\n\`\`\``);
              }
            } catch {
              // Not JSON, just return as text
              await context.sendActivity(`📄 ${text}`);
            }
          }
        }
      } else if (result?.text) {
        // Simple text response - try to parse as JSON
        try {
          const parsed = JSON.parse(result.text);
          if (parsed.downloadUrl && parsed.filename) {
            // Create adaptive card with download button
            const card = CardFactory.adaptiveCard({
              type: "AdaptiveCard",
              version: "1.4",
              body: [
                {
                  type: "TextBlock",
                  text: parsed.message || `Found document: ${parsed.filename}`,
                  size: "Medium",
                  weight: "Bolder",
                  wrap: true
                },
                {
                  type: "TextBlock",
                  text: `**Name:** ${parsed.name || parsed.filename}`,
                  wrap: true,
                  spacing: "Small"
                },
                ...(parsed.matchScore ? [{
                  type: "TextBlock",
                  text: `**Match Score:** ${parsed.matchScore}%`,
                  wrap: true,
                  spacing: "Small"
                }] : [])
              ],
              actions: [
                {
                  type: "Action.OpenUrl",
                  title: "Download Document",
                  url: parsed.downloadUrl
                }
              ]
            });
            
            await context.sendActivity({
              attachments: [card]
            });
          } else {
            await context.sendActivity(`📄 ${result.text}`);
          }
        } catch {
          // Not JSON, just return as text
          await context.sendActivity(`📄 ${result.text}`);
        }
      } else if (result) {
        // Try to handle as JSON with downloadUrl or file data
        try {
          const parsed = typeof result === 'object' ? result : JSON.parse(JSON.stringify(result));
          
          // Check if it's a document response with downloadUrl
          if (parsed.downloadUrl && parsed.filename) {
            // Create adaptive card with download button
            const card = CardFactory.adaptiveCard({
              type: "AdaptiveCard",
              version: "1.4",
              body: [
                {
                  type: "TextBlock",
                  text: parsed.message || `Found document: ${parsed.filename}`,
                  size: "Medium",
                  weight: "Bolder",
                  wrap: true
                },
                {
                  type: "TextBlock",
                  text: `**Name:** ${parsed.name || parsed.filename}`,
                  wrap: true,
                  spacing: "Small"
                },
                ...(parsed.matchScore ? [{
                  type: "TextBlock",
                  text: `**Match Score:** ${parsed.matchScore}%`,
                  wrap: true,
                  spacing: "Small"
                }] : [])
              ],
              actions: [
                {
                  type: "Action.OpenUrl",
                  title: "Download Document",
                  url: parsed.downloadUrl
                }
              ]
            });
            
            await context.sendActivity({
              attachments: [card]
            });
          } else if (parsed.data && parsed.filename) {
            // JSON with file data (base64)
            const fileData = Buffer.from(parsed.data, 'base64');
            const attachment = {
              contentType: parsed.contentType || 'application/pdf',
              contentUrl: `data:${parsed.contentType || 'application/pdf'};base64,${fileData.toString('base64')}`,
              name: parsed.filename,
            };
            await context.sendActivity({
              attachments: [attachment],
              text: `📄 Found: ${parsed.filename}`,
            });
          } else {
            // Fallback to text representation
            const resultStr = JSON.stringify(result);
            // Teams has a message limit of ~28KB, so we'll send up to ~25KB to be safe
            const maxLength = 25000;
            if (resultStr.length > maxLength) {
              await context.sendActivity(`📄 Result (showing first ${maxLength} chars of ${resultStr.length}):\n\`\`\`\n${resultStr.slice(0, maxLength)}\n\`\`\``);
              await context.sendActivity(`... (truncated ${resultStr.length - maxLength} more characters)`);
            } else {
              await context.sendActivity(`📄 Result: ${resultStr}`);
            }
          }
        } catch {
          // Fallback to text representation
          const resultStr = JSON.stringify(result);
          // Teams has a message limit of ~28KB, so we'll send up to ~25KB to be safe
          const maxLength = 25000;
          if (resultStr.length > maxLength) {
            await context.sendActivity(`📄 Result (showing first ${maxLength} chars of ${resultStr.length}):\n\`\`\`\n${resultStr.slice(0, maxLength)}\n\`\`\``);
            await context.sendActivity(`... (truncated ${resultStr.length - maxLength} more characters)`);
          } else {
            await context.sendActivity(`📄 Result: ${resultStr}`);
          }
        }
      } else {
        await context.sendActivity("❌ No document found or empty response.");
      }
    } catch (e: any) {
      await context.sendActivity(`❌ Error: ${e.message}`);
    }
    return;
  }

  // Send command selector as adaptive card
  const commandCard = await buildCommandCard();
  await context.sendActivity({
    text: " ",
    attachments: [commandCard]
  });
}

function getEmojiForResourceType(type: string): string {
  const emojiMap: { [key: string]: string } = {
    users: '👤',
    user: '👤',
    projects: '📁',
    project: '📁',
    documents: '📄',
    document: '📄',
    clients: '👥',
    client: '👥',
    checklists: '✅',
    checklist: '✅',
  };
  return emojiMap[type.toLowerCase()] || '📋';
}

// ---------- Helpers (keep your light wrappers) ----------
function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk.toString()));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
function createWebRequest(req: IncomingMessage, body: string): WebRequest {
  return {
    body: body ? JSON.parse(body) : undefined,
    headers: req.headers,
    method: req.method,
    on: req.on.bind(req),
  } as unknown as WebRequest;
}
function createWebResponse(res: ServerResponse) {
  return {
    socket: res.socket || ({} as any),
    end: (...args: any[]) => {
      res.end(...(args as [any]));
      return res as any;
    },
    header: (name: string, value: unknown) => {
      res.setHeader(name, value as string | string[]);
      return res as any;
    },
    send: (body: any) => {
      if (!res.headersSent) res.setHeader('Content-Type', 'application/json');
      res.write(typeof body === 'string' ? body : JSON.stringify(body));
      res.end();
      return res as any;
    },
    status: (status: number) => {
      res.statusCode = status;
      return res as any;
    },
  };
}

// ---------- HTTP server ----------
const server = http.createServer(async (req, res) => {
  // Health
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  // Teams webhook
  if (req.method === 'POST' && req.url === '/api/teams/messages') {
    try {
      const raw = await readRequestBody(req);
      const webReq = createWebRequest(req, raw);
      const webRes = createWebResponse(res);

      // optional: log basic activity info
      if (webReq.body) {
        console.log('\n=== Incoming Activity ===');
        console.log('Type:', webReq.body.type);
        console.log('From:', webReq.body.from?.name || webReq.body.from?.id);
        console.log('Channel:', webReq.body.channelId);
        console.log('Message Text:', webReq.body.text);
      }

      await adapter.process(webReq, webRes, async (ctx) => {
        await bot.run(ctx);
      });
    } catch (e) {
      console.error('processActivity error:', e);
      res.statusCode = 500;
      res.end();
    }
    return;
  }

  res.statusCode = 404;
  res.end();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('APP_ID:', APP_ID);
  console.log('TENANT:', APP_TENANT || '(not set)');
  console.log('TYPE:', APP_TYPE);
  console.log(`Bot listening on port ${PORT}`);
});

