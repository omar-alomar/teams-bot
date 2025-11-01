import 'dotenv/config';
import http from 'http';
import { IncomingMessage, ServerResponse } from 'http';
import { BotFrameworkAdapter, TurnContext, WebRequest, WebResponse } from 'botbuilder';


// Adapter with creds from .env
const adapter = new BotFrameworkAdapter({
  appId: process.env.MS_APP_ID,
  appPassword: process.env.MS_APP_PASSWORD,
});

const PORT = Number(process.env.PORT) || 3978;

// Core logic: just echo text for now
async function onTurn(context: TurnContext) {
  if (context.activity.type === 'message') {
    const text = (context.activity.text || '').trim();
    await context.sendActivity(`Echo: ${text}`);
  }
}

// Helper to read request body as string
function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      resolve(body);
    });
    req.on('error', reject);
  });
}

// Wrap native request to match WebRequest interface
function createWebRequest(req: IncomingMessage, body: string): WebRequest {
  return {
    body: body ? JSON.parse(body) : undefined,
    headers: req.headers,
    method: req.method,
    on: req.on.bind(req),
  };
}

// Wrap native response to match WebResponse interface
function createWebResponse(res: ServerResponse): WebResponse {
  return {
    socket: res.socket,
    end: (...args: any[]) => {
      res.end(...args);
      return res;
    },
    send: (body: any) => {
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'application/json');
      }
      res.write(JSON.stringify(body));
      res.end();
      return res;
    },
    status: (status: number) => {
      res.statusCode = status;
      return res;
    },
  };
}

// Basic HTTP server (no Express)
const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  // Teams webhook endpoint
  if (req.method === 'POST' && req.url === '/api/teams/messages') {
    try {
      const body = await readRequestBody(req);
      const webReq = createWebRequest(req, body);
      const webRes = createWebResponse(res);
      await adapter.processActivity(webReq, webRes, async (context) => onTurn(context));
    } catch (error) {
      console.error('Error processing activity:', error);
      res.statusCode = 500;
      res.end();
    }
    return;
  }

  res.statusCode = 404;
  res.end();
});

// Start
server.listen(PORT, '0.0.0.0', () =>
  console.log(`Bot listening on port ${PORT}`)
);
