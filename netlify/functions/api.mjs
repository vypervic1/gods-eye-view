/**
 * Netlify Function: the app's API, served from the same provider middleware
 * the Vite dev server runs.
 *
 * The client is a static build, so `/api/*` would otherwise 404 on a static
 * host. This function mounts the same provider plugins the dev server mounts
 * and answers with the same JSON, so the deployed site keeps its live layers.
 *
 * Netlify calls the function with a Web `Request`; the providers expect a
 * Node request and response. The adapter below provides both.
 */
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';

import { localProviderPlugins } from '../../server/providers/local.js';
import { apiNotFoundPlugin } from '../../server/standalone/api-not-found.js';

/** Netlify routes every `/api/*` request here. */
export const config = { path: '/api/*' };

/**
 * Headers the edge adds to every request. The same-site gate refuses a
 * request that carries them (it treats them as proof that the request came
 * through someone else's proxy), but here they are the edge's own headers and
 * no browser can attach them without a preflight this function never answers.
 * The Origin and Sec-Fetch-Site checks the gate also runs stay in force.
 */
const EDGE_HEADERS = [
  'forwarded',
  'via',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-real-ip',
  'cf-connecting-ip',
  'cf-ray',
];

/**
 * Collects what a provider handler writes, so the function can answer with
 * one Web `Response`.
 */
class FunctionResponse {
  constructor() {
    this.statusCode = 200;
    this.headers = new Map();
    this.chunks = [];
    this.writableEnded = false;
    this.destroyed = false;
  }

  writeHead(status, headers) {
    this.statusCode = status;
    if (Array.isArray(headers)) {
      for (const [name, value] of headers) this.setHeader(name, value);
    } else if (headers) {
      for (const [name, value] of Object.entries(headers))
        this.setHeader(name, value);
    }
    return this;
  }

  setHeader(name, value) {
    this.headers.set(String(name).toLowerCase(), value);
    return this;
  }

  getHeader(name) {
    return this.headers.get(String(name).toLowerCase());
  }

  getHeaders() {
    return Object.fromEntries(this.headers);
  }

  removeHeader(name) {
    this.headers.delete(String(name).toLowerCase());
  }

  write(chunk) {
    this.chunks.push(Buffer.from(chunk));
    return true;
  }

  end(chunk) {
    if (chunk) this.chunks.push(Buffer.from(chunk));
    this.writableEnded = true;
  }

  destroy() {
    this.destroyed = true;
  }

  body() {
    return Buffer.concat(this.chunks);
  }
}

/**
 * A Node-shaped request the providers can read: `method`, `url`, `headers`
 * and a readable body.
 */
function toNodeRequest(request, path, body) {
  const headers = {};
  for (const [name, value] of request.headers.entries()) headers[name] = value;
  for (const name of EDGE_HEADERS) delete headers[name];

  const req = Readable.from(body.length ? [body] : []);
  req.method = request.method;
  req.url = path;
  req.headers = headers;
  req.socket = { encrypted: true, remoteAddress: '127.0.0.1' };
  return req;
}

/** Read the whole request body (the providers read it as a stream). */
async function bodyOf(request) {
  if (!request.body) return Buffer.alloc(0);
  return Buffer.from(await request.arrayBuffer());
}

/**
 * Build the middleware stack once. The providers are Vite plugins, but they
 * only use `server.middlewares` and (optionally) `server.httpServer`.
 */
let stackPromise = null;
async function buildStack() {
  const routes = [];
  const httpServer = new EventEmitter();
  const server = {
    middlewares: {
      use(prefix, handler) {
        if (typeof prefix === 'function') {
          routes.push({ prefix: '', handler: prefix });
          return;
        }
        routes.push({ prefix: String(prefix), handler });
      },
    },
    httpServer,
    config: { root: process.cwd(), command: 'serve', mode: 'production' },
    resolvedUrls: { local: [], network: [] },
    ws: { send() {}, on() {} },
    watcher: { on() {}, add() {}, unwatch() {} },
  };

  const plugins = [
    ...localProviderPlugins({
      nominatimStorageDir: `${process.env.TMPDIR || '/tmp'}/gev-nominatim`,
    }),
    apiNotFoundPlugin(),
  ];
  for (const plugin of plugins) {
    if (typeof plugin.configureServer === 'function') {
      await plugin.configureServer(server);
    }
  }
  return routes;
}

function stack() {
  if (!stackPromise) stackPromise = buildStack();
  return stackPromise;
}

/**
 * Run the request through the middleware stack and answer with the collected
 * response.
 */
export async function handle(request) {
  const url = new URL(request.url);
  const routes = await stack();
  const res = new FunctionResponse();
  const body = await bodyOf(request);

  let index = 0;
  let outstanding = null;
  const next = () => {
    outstanding = (async () => {
      const route = routes[index++];
      if (!route) {
        if (!res.writableEnded) {
          res.statusCode = res.statusCode === 200 ? 404 : res.statusCode;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Unknown API route' }));
        }
        return;
      }
      const { prefix, handler } = route;
      let requestUrl = url.pathname + url.search;
      if (prefix) {
        if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
          return next();
        }
        requestUrl = url.pathname.slice(prefix.length) || '/';
        if (url.search) requestUrl += url.search;
      }
      const req = toNodeRequest(request, requestUrl, body);
      await handler(req, res, next);
    })();
    return outstanding;
  };

  await next();
  // A handler that calls next() without awaiting it still finishes the chain.
  while (outstanding) {
    const pending = outstanding;
    outstanding = null;
    await pending;
  }

  const headers = new Headers();
  for (const [name, value] of res.headers) {
    if (Array.isArray(value))
      for (const item of value) headers.append(name, item);
    else headers.set(name, String(value));
  }
  return new Response(res.body(), { status: res.statusCode, headers });
}

export default async (request) => handle(request);
