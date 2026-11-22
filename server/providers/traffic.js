import path from 'node:path';
import { promises as fsp } from 'node:fs';

import { readResponseBytesCapped } from './common/http.js';
import {
  isValidTileCoord as isValidTomTomTile,
  utcDayKey as tomtomUtcDayKey,
  normalizeBudget as normalizeTomTomBudget,
  isOverBudget as isTomTomOverBudget,
} from '../../src/data/tomtomTiles.js';
import { admitSameSite } from './common/same-site.js';

/** TomTom Maps flow tiles: the endpoint a Traffic Flow Maps key is assigned. */
const MAPS_FLOW_URL =
  'https://api.tomtom.com/traffic/map/4/tile/flow/relative/';
/** TomTom Orbis Maps flow tiles: the endpoint other keys are assigned. */
const ORBIS_FLOW_URL =
  'https://api.tomtom.com/maps/orbis/traffic/flow/vector/tile/';
/** How long a refused key is left alone before the proxy asks upstream again. */
const KEY_REJECTED_COOLDOWN_MS = 5 * 60_000;

/** A key both endpoints refused: the proxy stops asking for a while. */
class KeyRejectedError extends Error {
  constructor() {
    super('key rejected');
    this.name = 'KeyRejectedError';
    this.code = 'key_rejected';
  }
}

/**
 * TomTom traffic-flow vector-tile proxy with a daily budget governor.
 *
 * Upstream: https://api.tomtom.com/traffic/map/4/tile/flow/relative/{z}/{x}/{y}.pbf
 * (style `relative`; the response is an UNCOMPRESSED Mapbox Vector Tile, layer
 * "Traffic flow"). The key comes from TOMTOM_API_KEY server-side only — the
 * browser fetches same-origin `/api/tomtom/flow/{z}/{x}/{y}.pbf`.
 *
 * TomTom assigns keys per product, so a key that is not assigned the Traffic
 * Flow Maps product is refused with HTTP 403 there while it works on the
 * Orbis Maps flow endpoint
 * (https://api.tomtom.com/maps/orbis/traffic/flow/vector/tile/{z}/{x}/{y}).
 * The proxy asks the Maps endpoint first and, when the key is refused there,
 * asks Orbis instead; whichever endpoint answered is remembered for that key
 * until the key changes or the process restarts. The tile says which schema
 * it carries (`x-tomtom-schema`), because the two endpoints name the same
 * attributes differently.
 *
 * Cache: memory + disk (.gev-cache/tomtom/), TTL 120 s (traffic is fresh
 * data), single-flight per tile, serve-stale-on-failure — the celestrakProxy
 * pattern. Cache hits never count against the budget.
 *
 * Budget governor (mirrors the OpenSky credit-governor philosophy — last-good
 * data beats a dead layer): a persistent counter (.gev-cache/tomtom/budget.json,
 * keyed by UTC date, reset on day change) counts upstream fetch attempts
 * against a soft cap (TOMTOM_DAILY_TILE_BUDGET). Over the cap the proxy
 * serves stale tiles when available, else 429 {error:'budget'}.
 *
 * The default is derived from TomTom's published free allowance, which is
 * granted MONTHLY, not daily: 200,000 Traffic Flow & Incidents tile requests
 * per month (https://docs.tomtom.com/pricing/). The previous 40,000/day
 * default — and the "~50k/day" figure this comment used to cite — exhausted
 * a month's entire allowance in five days, leaving the traffic layer dead
 * for the rest of the billing period. 6,000/day keeps a full 31-day month
 * inside the allowance (186,000) with headroom to spare.
 *
 * Cross-site gate: both routes refuse cross-site browser requests with 403
 * (the gate Mapillary, OpenAI and Places already use). Every uncached tile is
 * a billed upstream attempt counted against the persistent daily budget, so
 * without the gate any web page the user visits could fire `<img>` requests
 * at distinct tiles, spend the TomTom quota and leave the traffic layer on
 * 429 budget for the rest of the UTC day.
 *
 * GET /api/tomtom/status → {hasKey, dailyCount, budget, date}. Keyless mode:
 * status reports hasKey:false and the tile endpoint 503s {error:'no_key'}
 * without touching upstream — the traffic layer then stays in simulation mode.
 *
 * @returns {import('vite').Plugin}
 */
export function tomtomProxy() {
  const TILE_TTL_MS = 120_000;
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache', 'tomtom');
  const BUDGET_PATH = path.join(CACHE_DIR, 'budget.json');
  // 200,000/month free tier / 31 days = 6,451. Rounded down for headroom.
  const DEFAULT_DAILY_BUDGET = 6000;
  const MEM_MAX_ENTRIES = 256;
  const UPSTREAM_TIMEOUT_MS = 15000;
  /** Flow tiles are well under 1 MB; this bounds a runaway body, not a budget. */
  const TOMTOM_TILE_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

  /** @type {Map<string, {at:number, buf:Buffer}>} tile key `z/x/y` -> cached tile (kept past TTL for serve-stale). */
  const mem = new Map();
  /** @type {Map<string, Promise<{at:number, buf:Buffer}|null>>} single-flight per tile. */
  const inflight = new Map();

  /** @type {{date:string, count:number}|null} lazily-loaded persistent counter. */
  let budget = null;
  let budgetLoaded = false;

  /** Which endpoint answered for the current key: 'maps' or 'orbis'. */
  let endpoint = null;
  /** The key that endpoint belongs to; a new key starts at the Maps endpoint. */
  let endpointKey = null;
  /** When a refused key may be asked about again. */
  let keyRejectedUntil = 0;

  /** Whether the current key is known to be refused. */
  function keyRejected() {
    return Date.now() < keyRejectedUntil;
  }

  function dailyBudgetLimit() {
    const raw = Number.parseInt(process.env.TOMTOM_DAILY_TILE_BUDGET || '', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_BUDGET;
  }

  async function loadBudgetOnce() {
    if (budgetLoaded) return;
    budgetLoaded = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(BUDGET_PATH, 'utf8'));
      if (
        parsed &&
        typeof parsed.date === 'string' &&
        Number.isFinite(parsed.count)
      ) {
        budget = parsed;
      }
    } catch {
      /* no budget file yet */
    }
  }

  async function persistBudget() {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(BUDGET_PATH, JSON.stringify(budget), 'utf8');
    } catch (err) {
      console.warn('[tomtom-proxy] budget write failed:', err?.message || err);
    }
  }

  /** Roll the counter to today (UTC) and return it. */
  function currentBudget() {
    budget = normalizeTomTomBudget(budget, tomtomUtcDayKey());
    return budget;
  }

  /** Count one upstream fetch attempt against today's budget (async persist). */
  function recordUpstreamFetch() {
    currentBudget().count += 1;
    void persistBudget();
  }

  const tilePath = (key) =>
    path.join(CACHE_DIR, `flow-${key.replaceAll('/', '-')}.pbf`);
  /** The sidecar says which schema the cached tile carries. */
  const schemaPath = (key) =>
    path.join(CACHE_DIR, `flow-${key.replaceAll('/', '-')}.schema`);

  /** Disk-cache read; tile age comes from the file's mtime. */
  async function readDiskTile(key) {
    try {
      const [stat, buf, schema] = await Promise.all([
        fsp.stat(tilePath(key)),
        fsp.readFile(tilePath(key)),
        fsp.readFile(schemaPath(key), 'utf8').catch(() => ''),
      ]);
      return { at: stat.mtimeMs, buf, schema: schema.trim() || 'maps' };
    } catch {
      return null;
    }
  }

  async function writeDiskTile(key, buf, schema) {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(tilePath(key), buf);
      await fsp.writeFile(schemaPath(key), schema);
    } catch (err) {
      console.warn(
        `[tomtom-proxy] tile cache write failed for ${key}:`,
        err?.message || err,
      );
    }
  }

  /** LRU-ish memory insert (Map preserves insertion order; evict the oldest). */
  function memSet(key, entry) {
    if (!mem.has(key) && mem.size >= MEM_MAX_ENTRIES) {
      const oldest = mem.keys().next().value;
      mem.delete(oldest);
    }
    mem.set(key, entry);
  }

  /**
   * Fetch one tile, asking the endpoint this key is assigned. A key refused
   * with 403 by the Maps endpoint is asked about on Orbis instead; the
   * endpoint that answered is remembered for that key.
   */
  async function fetchUpstream(z, x, y) {
    const key = process.env.TOMTOM_API_KEY || '';
    if (keyRejected()) throw new KeyRejectedError();
    // Another key may be assigned another product, so it starts at the Maps
    // endpoint again.
    if (endpointKey !== null && endpointKey !== key) endpoint = null;
    const order = endpoint === 'orbis' ? ['orbis', 'maps'] : ['maps', 'orbis'];
    for (const mode of order) {
      const url =
        mode === 'orbis'
          ? `${ORBIS_FLOW_URL}${z}/${x}/${y}?apiVersion=2&key=${encodeURIComponent(key)}`
          : `${MAPS_FLOW_URL}${z}/${x}/${y}.pbf?key=${encodeURIComponent(key)}`;
      recordUpstreamFetch(); // attempts count — upstream bills the request either way
      const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
      const res = await fetch(url, { signal });
      if (res.status === 403) continue; // this key is not assigned this product
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = await readResponseBytesCapped(
        res,
        TOMTOM_TILE_MAX_RESPONSE_BYTES,
        signal,
      );
      const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (buf.length === 0) throw new Error('empty tile body');
      endpoint = mode;
      endpointKey = key;
      return { buf, schema: mode };
    }
    // Both endpoints refused the key: leave upstream alone for a while.
    keyRejectedUntil = Date.now() + KEY_REJECTED_COOLDOWN_MS;
    throw new KeyRejectedError();
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/tomtom', async (req, res) => {
      // Gate first: a cross-site <img>/fetch must not reach the budget counter.
      if (admitSameSite(req, res)) return;
      // Sanitized responses only (proxy/security baseline): no upstream
      // error details, and never echo the key or the upstream URL.
      const sendJson = (status, obj, extraHeaders = {}) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          ...extraHeaders,
        });
        res.end(JSON.stringify(obj));
      };
      // x-tomtom-fetched-at is when the proxy fetched the tile (ms since the
      // epoch), so a client handed a STALE-* copy can say how old it is.
      // x-tomtom-schema says which endpoint produced the tile, because the
      // two name the same attributes differently.
      const sendTile = (entry, cacheStatus) => {
        if (res.headersSent) return;
        res.writeHead(200, {
          'Content-Type': 'application/x-protobuf',
          'Cache-Control': 'no-store',
          'x-tomtom-cache': cacheStatus,
          'x-tomtom-fetched-at': String(Math.round(entry.at)),
          'x-tomtom-schema': entry.schema || 'maps',
        });
        res.end(entry.buf);
      };

      try {
        await loadBudgetOnce();
        const urlPath = String(req.url || '').split('?')[0];

        if (urlPath === '/status') {
          const hasKey = Boolean(process.env.TOMTOM_API_KEY);
          const b = currentBudget();
          sendJson(200, {
            hasKey,
            dailyCount: b.count,
            budget: dailyBudgetLimit(),
            date: b.date,
            keyRejected: keyRejected(),
          });
          return;
        }

        const m = urlPath.match(/^\/flow\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
        if (!m) {
          sendJson(404, { error: 'not_found' });
          return;
        }
        const z = Number(m[1]);
        const x = Number(m[2]);
        const y = Number(m[3]);
        if (!isValidTomTomTile(z, x, y)) {
          sendJson(400, { error: 'invalid_tile' });
          return;
        }
        if (!process.env.TOMTOM_API_KEY) {
          sendJson(503, { error: 'no_key' });
          return;
        }
        // A refused key is not worth a tile request: both endpoints refused it
        // moments ago, so say so instead of spending the budget.
        if (keyRejected()) {
          sendJson(403, { error: 'key_rejected' });
          return;
        }

        const key = `${z}/${x}/${y}`;
        const now = Date.now();

        let entry = mem.get(key);
        if (!entry) {
          entry = await readDiskTile(key);
          if (entry) memSet(key, entry);
        }
        // Fresh cache hit — never counts against the budget.
        if (entry && now - entry.at < TILE_TTL_MS) {
          sendTile(entry, 'HIT');
          return;
        }

        // Budget governor: over the soft cap, last-good data beats a dead layer.
        if (isTomTomOverBudget(currentBudget(), dailyBudgetLimit())) {
          if (entry) {
            sendTile(entry, 'STALE-BUDGET');
          } else {
            sendJson(429, { error: 'budget' });
          }
          return;
        }

        // Stale or missing → refresh, single-flight per tile.
        if (!inflight.has(key)) {
          inflight.set(
            key,
            fetchUpstream(z, x, y)
              .then(async ({ buf, schema }) => {
                const fresh = { at: Date.now(), buf, schema };
                memSet(key, fresh);
                await writeDiskTile(key, buf, schema);
                return fresh;
              })
              .catch((err) => {
                if (err?.code === 'key_rejected') return { rejected: true };
                console.warn(
                  `[tomtom-proxy] ${key} fetch failed (${err?.message || err}) — serving stale if any`,
                );
                return null;
              })
              .finally(() => inflight.delete(key)),
          );
        }
        const fresh = await inflight.get(key);
        if (fresh?.rejected) {
          sendJson(403, { error: 'key_rejected' });
          return;
        }
        if (fresh) {
          sendTile(fresh, 'MISS');
        } else if (entry) {
          sendTile(entry, 'STALE-ERROR'); // upstream down — stale beats empty
        } else {
          sendJson(502, { error: 'upstream' });
        }
      } catch (err) {
        console.warn('[tomtom-proxy] error:', err?.message || err);
        sendJson(500, { error: 'proxy' });
      }
    });
  };
  return {
    name: 'tomtom-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
