import 'dotenv/config';
import http, { IncomingMessage, ServerResponse } from 'http';
import {
  ActivityHandler,
  CloudAdapter,
  ConfigurationServiceClientCredentialFactory,
  createBotFrameworkAuthenticationFromConfiguration,
  TurnContext,
  WebRequest,
  WebResponse,
} from 'botbuilder';
import { McpHttpClient } from "./mcpClient";

// create reusable client (one session)
const mcp = new McpHttpClient(process.env.MCP_BASE ?? "http://mcp:8080/mcp");

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
  const txt = (context.activity.text || '').trim();
  await context.sendActivity(`Goofy nigga says: ${txt}`);
  // ensure MCP session once
  try { await mcp.init(); } catch (e:any) {
    await context.sendActivity(`MCP init failed: ${e.message}`);
    return;
  }

  if (txt === "/ping") {
    const r = await mcp.listResources();
    const n = r?.resources?.length ?? 0;
    await context.sendActivity(`✅ MCP alive. ${n} resources.`);
    return;
  }

  if (txt === "/users") {
    const out = await mcp.readResource("users://all");
    const body = out?.contents?.[0]?.text ?? "[]";
    // Teams has a message limit of ~28KB, so we'll send up to ~25KB to be safe
    const maxLength = 25000;
    if (body.length > maxLength) {
      await context.sendActivity(`👤 Users (showing first ${maxLength} chars of ${body.length}):\n\`\`\`\n${body.slice(0, maxLength)}\n\`\`\``);
      await context.sendActivity(`... (truncated ${body.length - maxLength} more characters)`);
    } else {
      await context.sendActivity(`👤 Users:\n\`\`\`\n${body}\n\`\`\``);
    }
    return;
  }

  if (txt === "/projects") {
    const out = await mcp.readResource("projects://all");
    const body = out?.contents?.[0]?.text ?? "[]";
    // Teams has a message limit of ~28KB, so we'll send up to ~25KB to be safe
    const maxLength = 25000;
    if (body.length > maxLength) {
      await context.sendActivity(`📁 Projects (showing first ${maxLength} chars of ${body.length}):\n\`\`\`\n${body.slice(0, maxLength)}\n\`\`\``);
      await context.sendActivity(`... (truncated ${body.length - maxLength} more characters)`);
    } else {
      await context.sendActivity(`📁 Projects:\n\`\`\`\n${body}\n\`\`\``);
    }
    return;
  }

  await context.sendActivity("Commands: `/ping`, `/users`, `/projects`");
  await next();
});

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
