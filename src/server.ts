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

// ---------- ENV ----------
const PORT = Number(process.env.PORT) || 3978;
const APP_ID = process.env.MS_APP_ID!;
const APP_PASSWORD = process.env.MS_APP_PASSWORD!;
const APP_TENANT = process.env.MS_APP_TENANT_ID;   // optional, required for SingleTenant
const APP_TYPE = (process.env.MS_APP_TYPE || 'MultiTenant') as 'SingleTenant' | 'MultiTenant';

// Validate configuration
if (APP_TYPE === 'SingleTenant' && !APP_TENANT) {
  throw new Error(
    'MS_APP_TENANT_ID is required when MS_APP_TYPE is SingleTenant. ' +
    'Either set MS_APP_TENANT_ID in your .env file or change MS_APP_TYPE to MultiTenant.'
  );
}

// ---------- ADAPTER (tenant-aware) ----------
const credFactoryConfig: {
  MicrosoftAppId: string;
  MicrosoftAppPassword: string;
  MicrosoftAppType: 'SingleTenant' | 'MultiTenant';
  MicrosoftAppTenantId?: string;
} = {
  MicrosoftAppId: APP_ID,
  MicrosoftAppPassword: APP_PASSWORD,
  MicrosoftAppType: APP_TYPE,
};

// Only include tenant ID if provided (required for SingleTenant, optional for MultiTenant)
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
  await context.sendActivity(`Echo: ${txt}`);
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
  console.log('TENANT:', APP_TENANT || '(not set - using MultiTenant)');
  console.log('TYPE:', APP_TYPE);
  console.log(`Bot listening on port ${PORT}`);
});
