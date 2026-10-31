#!/usr/bin/env node
// MCP server (stdio) <-> WebSocket <-> "Google Maps MCP Bridge" Chrome extension.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { z } from 'zod';
import {
  STATUSES, analyzeHtml, classifyWebsite, addressInArea, imageExt, isMapsUrl, isPrivateHost, isShortener, byScore, gridTiles, stripVisited, haversineKm, parseCenter, plusCodeFromLines, zoomForRadius, mapPopularTimes, unwrapGoogleRedirect, viewportOfCards, jsonlOpt, jsonlTarget, leadKey, loadLeads, mergePhotos, ranked, scoreOf, summarizeActivity, withScore, toJsonlRow, writeJsonl,
  parsePlaceUrl, saveLeads, slug, toCsv, underHome, updateLead, upsertLead,
} from './leads.js';
import { ACTIONS_FILE, COMPOSITE, DIR, HANDLERS, LEADS_FILE, Queue, isFinal, isHalt } from './queue.js';

// Must match WS_URL in extension/background.js. Env override is for smoke tests.
const PORT = Number(process.env.GMAPS_CLI_WS_PORT) || 47832;
// Must equal extension/manifest.json "version"; bump both together on every change.
const VERSION = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url))).version;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const PHOTO_HOST = /^(lh\d+\.googleusercontent\.com|streetviewpixels-pa\.googleapis\.com)$/;

// ---------- Extension link ----------
// Several Claude sessions can use the bridge at once. The first server to bind the port is the primary: the
// extension connects to it, and every other server joins it as a peer (ws://.../peer) and relays calls through
// it. When the primary exits, peers race to bind the port; the winner becomes the new primary.

let ext = null; // primary: the extension socket
let extVersion = null; // from the extension's hello; null = too old to say
let extHalted = null; // reason while the extension is halted (captcha / consent wall) until Resume in the popup
let hub = null; // peer: socket to the primary
let hubState = { connected: false, extVersion: null, halted: null };
const peers = new Set();
let seq = 0;
const pending = new Map();

// ---------- Queue (primary only) ----------
// Every tool call is a job in one persistent queue with ONE worker, so the extension never runs two things at once.
// Sync tools enqueue at priority 1; gmaps_enqueue uses priority 0. Priority only picks the NEXT job.
// Composite jobs (findLeads, downloadPlace) run outside the worker as orchestrators: each browser step they need is
// its own queued job (same priority as the composite), so other sessions' calls interleave between the steps.
let shuttingDown = false;
let q = null;
let working = false;
let wake = null;
const waiters = new Map(); // jobId -> fn(job) for sync callers

const logAction = (e) => {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.appendFileSync(ACTIONS_FILE, JSON.stringify(e) + '\n'); } catch (err) {
    console.error(`[gmaps-mcp] action log failed: ${err.message}`);
  }
};

function notify(job) {
  const w = waiters.get(job.id);
  if (!w || !isFinal(job)) return;
  waiters.delete(job.id);
  w(job);
}

// Adds ids/coordinates parsed from place URLs to extension results, so queue results carry them too.
const POST = {
  search: (r) => {
    // Sponsored cards link to a Google ad redirect: use its target, or treat the website as unknown (null) so the place gets opened.
    const cards = (r?.cards || []).map((c) => {
      const website = c.website ? unwrapGoogleRedirect(c.website) : null;
      const name = stripVisited(c.name);
      const category = stripVisited(c.category);
      return {
        ...c, ...parsePlaceUrl(c.placeUrl), name, website, hasWebsite: website ? true : c.hasWebsite === false ? false : null,
        category: /Visited link/i.test(c.name || '') && category === name ? null : category, // a visited card once leaked the name into category
        address: stripVisited(c.address),
      };
    });
    return { ...r, viewport: r?.viewport || viewportOfCards(cards), cards };
  },
  getPlace: ({ activitySample, ...r }) => {
    const un = (v) => (Array.isArray(v) ? v.map(unwrapGoogleRedirect).filter(Boolean) : v ? unwrapGoogleRedirect(v) : v);
    const activity = summarizeActivity(activitySample);
    return {
      ...r, website: un(r.website) ?? null,
      ...(r.links && { links: Object.fromEntries(Object.entries(r.links).map(([k, v]) => [k, un(v)])) }),
      ...(r.social && { social: un(r.social) }),
      popularTimes: mapPopularTimes(r.popularTimes, r.hours),
      ...(activity && { activity }), ...parsePlaceUrl(r.placeUrl),
    };
  },
  getCompetitors: (r) => ({ ...r, competitors: (r?.competitors || []).map((c) => ({ ...c, ...parsePlaceUrl(c.placeUrl) })) }),
};

function finish(job, out, t0) {
  const j = q.complete(job.id, out);
  if (out.error && isHalt(out.error)) { extHalted ||= out.error.replace(/^HALT:\s*/, ''); broadcast(); }
  logAction({
    ts: new Date().toISOString(), jobId: j.id, parent: j.parent, tool: j.tool, args: j.args, status: j.status,
    error: out.error, durationMs: Date.now() - t0, attempt: j.attempts, sessionPid: process.pid,
  });
  notify(j);
}

async function runJob(job) {
  const ws = ext;
  q.start(job);
  const t0 = Date.now();
  let out;
  try {
    const r = await send(ws, job.tool, job.args);
    out = { result: POST[job.tool] ? POST[job.tool](r) : r };
  } catch (e) { out = { error: e.message }; }
  finish(job, out, t0);
}

function runComposite(job) {
  q.start(job);
  const t0 = Date.now();
  const step = (tool, args) => runSync(tool, args, { priority: job.priority, parent: job.id });
  COMPOSITES[job.tool](job.args, step)
    .then((result) => ({ result }), (e) => ({ error: e.message }))
    .then((out) => { finish(job, out, t0); kick(); });
}

const ready = () => !shuttingDown && ext && extVersion === VERSION && !extHalted;

async function pump() {
  if (working || !q) return;
  working = true;
  try {
    while (ready()) {
      const job = q.next();
      if (!job) break;
      await runJob(job); // one at a time
    }
  } finally { working = false; }
  if (ready()) for (let j; (j = q.next(true)); ) runComposite(j);
  clearTimeout(wake);
  const at = q.wakeAt();
  if (at && ready()) wake = setTimeout(kick, Math.min(Math.max(at - Date.now(), 1000), 2 ** 31 - 1)).unref();
}
const kick = () => pump().catch((e) => console.error(`[gmaps-mcp] worker: ${e.stack}`));

function runSync(tool, args, { priority = 1, parent } = {}) {
  const job = q.enqueue({ tool, args, priority, parent });
  return new Promise((resolve, reject) => {
    waiters.set(job.id, (j) => {
      if (j.status === 'done') return resolve(j.result);
      reject(new Error(j.status === 'unverified'
        ? `Unverified (job ${j.id}): ${j.error}. Check the Maps tab before retrying.`
        : j.error || `Job ${j.id} ${j.status}`));
    });
    kick();
  });
}

function enqueue({ tool, args = {}, notBefore, key }) {
  const j = q.enqueue({ tool, args, key, priority: 0, notBefore });
  kick();
  return { jobId: j.id, status: j.status };
}

function queueOp({ action, id, status, limit }) {
  if (action === 'list') return q.list({ status, limit }).map(({ result, ...j }) => ({ ...j, hasResult: result !== undefined }));
  if (id === undefined) throw new Error('id required');
  if (action === 'get') return q.get(id) || (() => { throw new Error(`No job ${id}`); })();
  const j = q.cancel(id);
  notify(j);
  return j;
}

// Calls arriving here from this process (primary) or relayed by peers. '@' = queue management, no extension needed.
async function dispatch(tool, args) {
  if (!q) throw new Error('Bridge starting; retry');
  if (tool === '@enqueue') return enqueue(args);
  if (tool === '@queue') return queueOp(args);
  assertReady(link());
  return runSync(tool, args);
}

let wsError = null;
function listen() {
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: PORT,
    // Extension, or a local peer server. Browsers always send Origin on WebSocket handshakes, so a request
    // without one is a local process, never a web page hitting localhost.
    verifyClient: ({ origin, req }) => (typeof origin === 'string' && origin.startsWith('chrome-extension://'))
      || (!origin && req.url === '/peer'),
  });
  wss.on('listening', () => {
    wsError = null;
    console.error('[gmaps-mcp] primary');
    if (!q) q = new Queue().load(); // recovery of jobs left running happens here
    kick();
  });
  wss.on('error', (e) => {
    if (e.code === 'EADDRINUSE') return joinHub();
    wsError = e.message;
    console.error(`[gmaps-mcp] WebSocket error: ${wsError}`);
    setTimeout(listen, 5000);
  });
  wss.on('connection', (ws, req) => (req.url === '/peer' ? onPeer(ws) : onConnection(ws)));
}
if (!process.argv.includes('--catalog')) listen();
// Exit with the MCP client; otherwise the WebSocket keeps an orphan holding the port.
if (!process.argv.includes('--catalog')) process.stdin.on('end', () => process.exit(0));

function settle(msg) {
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
}

function joinHub() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/peer`);
  ws.on('open', () => { hub = ws; wsError = null; console.error('[gmaps-mcp] peer of the primary server'); });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'state') hubState = msg;
    else settle(msg);
  });
  ws.on('error', () => {}); // 'close' follows
  ws.on('close', () => {
    if (hub === ws) {
      hub = null;
      for (const p of pending.values()) p.reject(new Error('Primary bridge server exited; retry the call'));
      pending.clear();
    }
    hubState = { connected: false, extVersion: null, halted: null };
    setTimeout(listen, 500 + Math.random() * 1500); // try to become primary, else join the new one
  });
}

const state = () => JSON.stringify({ type: 'state', connected: !!ext, extVersion, halted: extHalted });
const broadcast = () => { for (const p of peers) p.send(state()); };

function onPeer(ws) {
  peers.add(ws);
  ws.send(state());
  ws.on('message', (raw) => {
    const { id, tool, args } = JSON.parse(raw);
    dispatch(tool, args).then(
      (result) => ws.send(JSON.stringify({ id, result })),
      (e) => ws.send(JSON.stringify({ id, error: e.message })),
    );
  });
  ws.on('close', () => peers.delete(ws));
}

function onConnection(ws) {
  ext = ws;
  extVersion = null;
  console.error('[gmaps-mcp] extension connected');
  ws.send(JSON.stringify({ type: 'hello', version: VERSION }));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'hello') {
      extVersion = msg.version;
      extHalted = msg.halted || null;
      console.error(`[gmaps-mcp] extension ${extVersion}, server ${VERSION}`);
    } else if (msg.type === 'halted') extHalted = msg.reason || null; // popup Resume sends null
    else return settle(msg);
    broadcast();
    kick();
  });
  ws.on('close', () => {
    if (ext === ws) { ext = null; extHalted = null; broadcast(); }
    for (const [id, p] of pending) if (p.ws === ws) { pending.delete(id); p.reject(new Error('Extension disconnected while the action was running')); }
  });
}
setInterval(() => ext?.send('{"type":"ping"}'), 20000);

// Where this process's calls go: straight to the extension (primary) or through the primary (peer).
const link = () => (hub
  ? { ws: hub, connected: hubState.connected, version: hubState.extVersion, halted: hubState.halted, role: 'peer' }
  : { ws: ext, connected: !!ext, version: extVersion, halted: extHalted, role: 'primary' });

// Browser steps are bounded by the extension; composites (many steps) get hours.
function send(ws, tool, args = {}, timeoutMs = COMPOSITE.has(tool) ? 6 * 3600e3 : 10 * 60e3) {
  if (!ws) return Promise.reject(new Error('Extension not connected. Open Chrome with "Google Maps MCP Bridge" enabled.'));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${tool} timed out`)); }, timeoutMs);
    pending.set(id, {
      ws,
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    ws.send(JSON.stringify({ id, tool, args }));
  });
}

function assertReady(l) {
  if (!l.connected) throw new Error('Extension not connected. Open Chrome with "Google Maps MCP Bridge" enabled.');
  if (l.version !== VERSION) {
    throw new Error(l.version
      ? `Version mismatch: extension ${l.version}, server ${VERSION}. Reload the extension in chrome://extensions, or /mcp reconnect if the server is older.`
      : `Extension is older than ${VERSION} (no version handshake). Reload it in chrome://extensions.`);
  }
  if (l.halted) throw new Error(`HALT: ${l.halted}. Resolve it in the Maps tab, then press Resume in the extension popup.`);
}

// All browser tools go through the primary's queue (directly, or relayed by the peer). '@' tools work without the extension.
function call(tool, args = {}) {
  if (wsError) throw new Error(`Bridge unavailable: ${wsError}`);
  const l = link();
  if (l.role === 'peer') {
    if (tool[0] !== '@') assertReady(l);
    return send(l.ws, tool, args);
  }
  return dispatch(tool, args);
}

// ---------- Validation & server-side fetch ----------

const need = (u) => {
  if (!isMapsUrl(u)) throw new Error(`Only Google Maps URLs are accepted (https://www.google.com/maps..., https://maps.app.goo.gl/..., https://goo.gl/maps/...): ${u}`);
  return u;
};
const needUrl = (a) => ({ ...a, url: need(a.url) });
// Per-tool arg normalisation, shared by the sync tools and gmaps_enqueue. Tools not listed pass through as-is.
const prep = {
  getPlace: needUrl,
  getReviews: needUrl,
  search: (a) => { if (a.at != null && !/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,\d+(\.\d+)?$/.test(a.at)) throw new Error(`Bad map position: ${a.at}`); return a; },
  getPhotos: needUrl,
  getCompetitors: needUrl,
  competitors: needUrl,
  downloadPlace: (a) => ({ ...needUrl(a), dir: a.dir ? underHome(a.dir) : undefined }),
  findLeads: (a) => {
    if (!a.query) throw new Error('query required');
    const hasAreas = a.areas?.length > 0;
    if (hasAreas === (a.center != null)) throw new Error('Give exactly one of `areas` or `center` + `radiusKm`');
    if (!hasAreas) return { ...a, ...checkRadius(a), center: parseCenter(a.center) };
    if (a.radiusKm != null) throw new Error('radiusKm goes with center, not areas');
    return a;
  },
  placeAt: (a) => {
    const c = parseCenter({ lat: a.lat, lng: a.lng });
    if (a.radiusM != null && !(a.radiusM >= 1 && a.radiusM <= 5000)) throw new Error('radiusM must be 1..5000');
    return { ...a, ...c };
  },
};

const checkRadius = ({ radiusKm }) => {
  if (!(radiusKm >= 0.1 && radiusKm <= 50)) throw new Error('radiusKm (0.1..50) is required with center');
  return { radiusKm };
};

// GET with a body cap, timeout and manual redirects (every hop is re-checked against the private-host guard).
async function fetchBody(url, { max, timeout = 10000 }) {
  let u = new URL(url);
  for (let hop = 0; hop < 6; hop++) {
    if (!/^https?:$/.test(u.protocol) || isPrivateHost(u.hostname)) throw new Error(`Refusing to fetch ${u.href}`);
    const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(timeout), headers: { 'user-agent': UA, accept: '*/*' } });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) { u = new URL(loc, u); await res.body?.cancel(); continue; }
    const chunks = [];
    let n = 0;
    let truncated = false;
    if (res.body) for await (const c of res.body) { n += c.length; if (n > max) { truncated = true; break; } chunks.push(c); }
    return { status: res.status, url: u.href, headers: res.headers, body: Buffer.concat(chunks), truncated };
  }
  throw new Error('Too many redirects');
}

// Follows a shortener (bit.ly...) to its final URL, SSRF-guarded; null when it cannot be resolved.
async function resolveWebsite(url) {
  if (!isShortener(url)) return null;
  try { return (await fetchBody(/^https?:\/\//i.test(url) ? url : `https://${url}`, { max: 1024, timeout: 8000 })).url; } catch { return null; }
}

async function checkWebsite({ url }) {
  const u = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  let r;
  try { r = await fetchBody(u, { max: 2 * 1024 * 1024 }); } catch (e) {
    return { reachable: false, url: u, error: `${e.message}${e.cause?.code ? ` (${e.cause.code})` : ''}` };
  }
  const isHtml = /html|text/i.test(r.headers.get('content-type') || '');
  const a = isHtml ? analyzeHtml(r.body.toString('utf8')) : {};
  return {
    reachable: r.status < 400, status: r.status, finalUrl: r.url, redirected: r.url !== u, https: r.url.startsWith('https:'),
    ...a,
    placeholder: { social_only: 'social', weak_website: 'builder' }[classifyWebsite(r.url)] || null,
    lastModified: r.headers.get('last-modified'),
    outdatedHint: a.copyrightYear ? a.copyrightYear <= new Date().getFullYear() - 3 : null,
    truncated: r.truncated,
  };
}

// ---------- Leads ----------

const COLS = ['id', 'name', 'status', 'leadScore', 'leadReasons', 'classification', 'phone', 'address', 'category', 'rating', 'reviewsCount', 'claimed',
  'website', 'websiteResolved', 'placeUrl', 'lat', 'lng', 'note', 'firstSeen', 'lastSeen', 'updatedAt'];
const brief = ({ id, name, status, leadScore, leadReasons, activity, distanceKm, classification, phone, address, rating, reviewsCount, claimed, website, websiteResolved, category, placeUrl, note }) =>
  ({ id, name, status, leadScore, leadReasons, activity, distanceKm, classification, phone, address, rating, reviewsCount, claimed, website, websiteResolved, category, placeUrl, note });

// Load-modify-save in one sync step, so concurrent sessions rarely clobber each other.
function saveLead(lead) {
  const r = upsertLead(loadLeads(LEADS_FILE), lead);
  const scored = withScore(r.lead); // score is recomputed from the merged record on every save
  r.list[r.list.findIndex((l) => l.id === scored.id)] = scored;
  saveLeads(LEADS_FILE, r.list);
  return scored;
}

// ---------- Composite jobs (run in the primary; `step` enqueues one browser job and awaits it) ----------

// Non-HALT failures of one place must not abort a long run; HALT must.
const soft = (fn, onError) => fn().catch((e) => { if (isHalt(e.message)) throw e; return onError(e); });

async function findLeads({ query, areas, center, radiusKm, limit = 40, includeWeakWebsites = true, strictArea = true, grid }, step) {
  const seen = new Set();
  const out = [];
  const errors = [];
  const stats = { searches: 0, cards: 0, opened: 0, skippedWithWebsite: 0, known: 0, outOfArea: 0, outOfRadius: 0, tiles: 0 };
  const skipClass = (k) => k === 'has_website' || ((k === 'social_only' || k === 'weak_website') && !includeWeakWebsites);
  const km = (pt) => (center && pt?.lat != null && pt?.lng != null ? Math.round(haversineKm(center, pt) * 100) / 100 : null);
  const tileSearch = async (q, t) => {
    const r = await soft(() => step('search', { query: q, limit, at: `${t.lat},${t.lng},${t.zoom}` }), (e) => { errors.push({ tile: `${t.lat},${t.lng}`, error: e.message }); return {}; });
    stats.tiles++;
    return r.cards || [];
  };
  for (const area of center ? [null] : areas?.length ? areas : [null]) {
    const q = area ? `${query} in ${area}` : query;
    let cards = [];
    if (center) { // a circle: search the tiles of its viewport (default grid by radius; 1 = a single search at the center)
      const n = grid ?? (radiusKm <= 2 ? 1 : radiusKm <= 5 ? 2 : 3);
      for (const t of gridTiles({ ...center, zoom: zoomForRadius(radiusKm, center.lat) }, n)) cards = cards.concat(await tileSearch(q, t));
    } else {
      const first = await step('search', { query: q, limit });
      stats.searches++;
      cards = first.cards || [];
      if ((grid ?? 1) > 1 && first.viewport) { // big city: search tiles of the viewport too; duplicates are dropped by the key check below
        for (const t of gridTiles(first.viewport, grid)) cards = cards.concat(await tileSearch(q, t));
      }
    }
    for (const c of cards) {
      const key = leadKey(c);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      stats.cards++;
      const dCard = km(c); // card coordinates are the place's own, unlike its bare street address
      if (dCard != null && dCard > radiusKm) { stats.outOfRadius++; continue; }
      if (c.hasWebsite && !isShortener(c.website) && skipClass(classifyWebsite(c.website))) { stats.skippedWithWebsite++; continue; }
      const prior = loadLeads(LEADS_FILE).find((l) => l.id === key);
      if (prior) { // already tracked (any status): never re-open or re-contact blindly
        stats.known++;
        if (!skipClass(prior.classification)) out.push(prior);
        continue;
      }
      const p = await soft(() => step('getPlace', { url: c.placeUrl, activity: true }), (e) => { errors.push({ place: c.name, error: e.message }); return null; });
      if (!p) continue;
      stats.opened++;
      // Google returns neighbours (Vinnytsia for "Vynnyky"). Only the full address from getPlace has the city; list cards
      // show a bare street, so they are not checked. A rejected place stays claimable by another area's search.
      const distanceKm = km(p.lat != null ? p : c);
      if (distanceKm != null && distanceKm > radiusKm) { stats.outOfRadius++; continue; }
      if (strictArea && area && !addressInArea(p.address, area)) { stats.outOfArea++; seen.delete(key); continue; }
      const websiteResolved = await resolveWebsite(p.website);
      const cls = classifyWebsite(websiteResolved || p.website); // classify by the final URL
      if (p.closed === 'permanent' || skipClass(cls)) { if (cls === 'has_website') stats.skippedWithWebsite++; continue; }
      out.push(saveLead({
        name: p.name || c.name, placeUrl: p.placeUrl || c.placeUrl, category: p.category || c.category,
        address: p.address || c.address, phone: p.phone || c.phone, website: p.website, websiteResolved, classification: cls,
        rating: p.rating ?? c.rating, reviewsCount: p.reviewsCount ?? c.reviewsCount, claimed: p.claimed, activity: p.activity, distanceKm,
        lat: p.lat ?? c.lat, lng: p.lng ?? c.lng, fid: p.fid ?? c.fid, placeId: p.placeId ?? c.placeId, query,
      }));
    }
  }
  return { query, areas: areas || null, ...(center && { center, radiusKm }), stats, errors, leadsFile: LEADS_FILE, leads: ranked(out).map(brief) };
}

async function downloadPlace({ url, dir, photos = 30, reviews = 20 }, step) {
  const place = await step('getPlace', { url });
  place.websiteResolved = await resolveWebsite(place.website);
  const purl = place.placeUrl || url;
  const warnings = [];
  const photoFail = (e) => { warnings.push(`photos: ${e.message}`); return {}; };
  const owner = photos > 0 ? await soft(() => step('getPhotos', { url: purl, limit: photos, category: 'By owner' }), photoFail) : {};
  const rest = photos > 0 ? await soft(() => step('getPhotos', { url: purl, limit: photos + (owner.photos || []).length }), photoFail) : {};
  const rv = reviews > 0 ? await soft(() => step('getReviews', { url: purl, limit: reviews }), (e) => { warnings.push(`reviews: ${e.message}`); return {}; }) : {};

  const short = (place.fid || place.placeId || '').replace(/[^A-Za-z0-9]/g, '').slice(-8) || String(Date.now()).slice(-8);
  const folder = path.join(dir ? underHome(dir) : path.join(os.homedir(), 'gmaps-cli-leads'), `${slug(place.name)}-${short}`);
  fs.mkdirSync(path.join(folder, 'photos'), { recursive: true });

  const files = [];
  const hashes = new Set();
  let skipped = 0;
  for (const { url: u, byOwner } of mergePhotos(owner.photos, rest.photos)) {
    if (files.length >= photos) break;
    try {
      if (!PHOTO_HOST.test(new URL(u).hostname)) throw new Error('host not allowed');
      const r = await fetchBody(u, { max: 10 * 1024 * 1024, timeout: 30000 });
      const ext_ = r.status === 200 && !r.truncated ? imageExt(r.body) : null; // magic bytes, not the content-type
      if (!ext_) throw new Error('not an image or too large');
      const sha = crypto.createHash('sha1').update(r.body).digest('hex');
      if (hashes.has(sha)) throw new Error('duplicate');
      hashes.add(sha);
      const file = `photos/${String(files.length + 1).padStart(2, '0')}.${ext_}`;
      fs.writeFileSync(path.join(folder, file), r.body);
      files.push({ file, url: u, byOwner });
    } catch (e) { skipped++; warnings.push(`photo skipped (${e.message}): ${u}`); }
  }
  const reviewList = rv.reviews || [];
  fs.writeFileSync(path.join(folder, 'place.json'), JSON.stringify({ ...place, savedAt: new Date().toISOString(), photos: files, reviews: reviewList }, null, 2));
  fs.writeFileSync(path.join(folder, 'place.md'), placeMarkdown(place, reviewList, files));
  return { folder, photos: files.length, photosSkipped: skipped, reviews: reviewList.length, warnings };
}

// Sales pitch material: the "People also search for" places of a business and whether they have websites.
async function competitors({ url, limit = 10, checkWebsites = false }, step) {
  const r = await step('getCompetitors', { url, limit });
  const list = (r.competitors || []).slice(0, limit);
  const errors = [];
  if (checkWebsites) {
    for (const c of list.filter((x) => x.placeUrl)) { // items whose URL could not be read stay unchecked
      const p = await soft(() => step('getPlace', { url: c.placeUrl, activity: false }), (e) => { errors.push({ place: c.name, error: e.message }); return null; });
      if (!p) continue;
      c.website = p.website ?? null;
      c.websiteResolved = await resolveWebsite(p.website);
      c.classification = classifyWebsite(c.websiteResolved || p.website);
      Object.assign(c, scoreOf({ classification: c.classification, reviewsCount: c.reviewsCount ?? p.reviewsCount, rating: c.rating ?? p.rating, claimed: p.claimed, phone: p.phone, closed: p.closed }));
    }
  }
  return {
    name: r.name, placeUrl: r.placeUrl, count: list.length,
    ...(checkWebsites && { checked: list.filter((c) => c.classification).length, withWebsite: list.filter((c) => c.classification === 'has_website').length }),
    errors, competitors: list,
  };
}

// What is at a coordinate? Maps shows only a plus code for a bare point, so: click the map there (clickPoi finds the place exactly
// at the point), and search around it only when asked (a search by a generic word misses the place at the point).
async function placeAt({ lat, lng, query, radiusM = 60, details = false, nearby = false }, step) {
  const pt = await step('getPoint', { lat, lng });
  const { plusCode, locality } = plusCodeFromLines(pt.lines);
  const dist = (c) => Math.round(haversineKm({ lat, lng }, c) * 1000) / 1000;
  const hit = await step('clickPoi', { lat, lng });
  let place = null;
  if (hit?.placeUrl) {
    const ids = parsePlaceUrl(hit.placeUrl);
    place = { name: hit.name ?? null, placeUrl: hit.placeUrl, ...ids, distanceKm: ids.lat != null ? dist(ids) : null };
  }
  let nearest = [];
  if (query || (!place && nearby)) { // nearby without a query looks for "shop"
    const s = await step('search', { query: query || 'shop', limit: 20, at: `${lat},${lng},18` });
    nearest = (s.cards || []).filter((c) => c.lat != null && c.lng != null).map((c) => ({ ...c, distanceKm: dist(c) }))
      .sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 10);
    if (!place && nearest.length && nearest[0].distanceKm * 1000 <= radiusM) place = nearest[0];
  }
  if (details && place) place = { ...place, details: await step('getPlace', { url: place.placeUrl }) };
  return { lat, lng, plusCode, locality, place, nearest };
}

const COMPOSITES = { findLeads, downloadPlace, competitors, placeAt };

// Brief for building the business's website.
function placeMarkdown(p, reviews, files) {
  const L = [`# ${p.name}`, ''];
  const kv = (k, v) => { if (v != null && v !== '') L.push(`- **${k}:** ${v}`); };
  kv('Category', p.category);
  kv('Rating', p.rating != null ? `${p.rating} (${p.reviewsCount ?? '?'} reviews)` : null);
  kv('Address', p.address);
  kv('Phone', p.phone);
  kv('Website', p.website ? `${p.website}${p.websiteResolved ? ` -> ${p.websiteResolved}` : ''}` : 'none (lead)');
  kv('Price', [p.priceLevel, p.priceRange].filter(Boolean).join(' '));
  kv('Located in', p.locatedIn);
  kv('Last review', p.activity?.lastReviewAgo);
  kv('Plus code', p.plusCode);
  kv('Coordinates', p.lat != null ? `${p.lat}, ${p.lng}` : null);
  kv('Claimed on Google', p.claimed == null ? null : p.claimed ? 'yes' : 'no');
  kv('Status', p.closed ? `${p.closed} closed` : null);
  kv('Google Maps', p.placeUrl);
  const hours = Object.entries(p.hours || {});
  if (hours.length) L.push('', '## Opening hours', ...hours.map(([d, t]) => `- ${d}: ${t}`));
  if (p.description) L.push('', '## About', p.description);
  if (p.fromBusiness && p.fromBusiness !== p.description) L.push('', '## From the business', p.fromBusiness);
  if (p.services?.length) L.push('', '## Services', ...p.services.map((x) => `- ${x.name}${x.price ? ` - ${x.price}` : ''}${x.description ? `: ${x.description}` : ''}`));
  if (p.reviewTopics?.length) L.push('', '## What reviewers mention', ...p.reviewTopics.map((t) => `- ${t.topic} (${t.count})`));
  if (p.ratingDistribution?.length) L.push('', '## Rating distribution', ...p.ratingDistribution.map((r) => `- ${r.stars} stars: ${r.count}`));
  if (p.photoCategories?.length) L.push('', `Photo categories: ${p.photoCategories.join(', ')}`);
  for (const [h, items] of Object.entries(p.about || {})) L.push('', `### ${h}`, ...items.map((i) => `- ${i}`));
  const links = [...Object.entries(p.links || {}).flatMap(([k, v]) => [].concat(v || []).map((u) => `${k}: ${u}`)), ...(p.social || [])];
  if (links.length) L.push('', '## Links', ...links.map((l) => `- ${l}`));
  const quotes = reviews.filter((r) => r.text).slice(0, 8);
  if (quotes.length) L.push('', '## Review quotes', ...quotes.map((r) => `> ${r.text.replace(/\s+/g, ' ')}\n> - ${r.author || 'anonymous'}${r.rating ? `, ${r.rating}/5` : ''}${r.date ? `, ${r.date}` : ''}\n`));
  if (files.length) L.push('', '## Photos', ...files.map((f) => `- ${f.file}${f.byOwner ? ' (by owner)' : ''}`));
  return L.join('\n') + '\n';
}

// ---------- Tools ----------

const ok = (result) => ({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
const tool = (fn) => async (args) => {
  try { return ok(await fn(args)); } catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; }
};
const prepped = (name) => (args) => call(name, prep[name] ? prep[name](args) : args);

// Optional laya-cli output: rows written as JSONL (true = default file, string = path inside $HOME); result is otherwise unchanged.
const jsonlArg = z.union([z.boolean(), z.string()]).optional().describe('Also write laya-cli JSONL rows: true = ~/gmaps-leads/jsonl/<kind>s-<time>.jsonl, or a path inside your home directory. Adds jsonlPath and jsonlRows to the result');
const emitJsonl = (opt, kind, rows) => {
  const o = jsonlOpt(opt);
  if (!o) return {};
  const file = writeJsonl(jsonlTarget(kind, o === true ? undefined : o), rows.map((r) => toJsonlRow(kind, r)));
  return { jsonlPath: file, jsonlRows: rows.length };
};
const jsonlTool = (name, kind, rowsOf, run = prepped(name)) => async ({ jsonl, ...args }) => {
  const o = jsonlOpt(jsonl);
  if (o) jsonlTarget(kind, o === true ? undefined : o); // validate the path before the slow browser work
  const r = await run(args);
  return o ? { ...r, ...emitJsonl(o, kind, rowsOf(r, args)) } : r;
};

const registry = new Map();
const server = {
  registerTool(name, spec, handler) {
    registry.set(name, { ...spec, handler });
  },
};
const urlArg = z.string().describe('Google Maps place URL (https://www.google.com/maps/place/..., maps.app.goo.gl or goo.gl/maps short link), e.g. a placeUrl from gmaps_search');

server.registerTool('gmaps_status', {
  description: 'Bridge health: server and extension versions, whether they match, connection state, role (primary/peer), halted state (captcha/consent wall: resolve in the Maps tab, press Resume in the popup).',
}, tool(async () => {
  const l = link();
  return { server: VERSION, extension: l.version, match: l.version === VERSION, connected: l.connected, role: l.role, halted: l.halted, wsError, dir: DIR };
}));

// gmaps_search with center + radiusKm: search at that map position, add distanceKm, drop cards beyond the radius, sort by distance.
async function searchRun({ center, radiusKm, sort, ...args }) {
  const c = center == null ? null : parseCenter(center);
  if (!c !== (radiusKm == null)) throw new Error('center and radiusKm go together');
  if (!c) return prepped('search')(args);
  checkRadius({ radiusKm });
  const r = await prepped('search')({ ...args, at: `${c.lat},${c.lng},${zoomForRadius(radiusKm, c.lat)}` });
  let outOfRadius = 0;
  const cards = [];
  for (const x of r.cards || []) {
    const d = x.lat != null && x.lng != null ? Math.round(haversineKm(c, x) * 100) / 100 : null; // no coordinates: kept, distance unknown
    if (d != null && d > radiusKm) outOfRadius++;
    else cards.push({ ...x, distanceKm: d });
  }
  if (sort !== 'relevance') cards.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
  return { ...r, cards, count: cards.length, outOfRadius, center: c, radiusKm };
}

const centerArg = z.union([z.string(), z.object({ lat: z.number(), lng: z.number() })]).describe('Map point: { lat, lng } or "lat,lng"');

server.registerTool('gmaps_search', {
  description: 'Google Maps search (English UI, hl=en). Scrolls the results feed until `limit` or the end of the list. Returns { cards: [{ name, placeUrl, rating, reviewsCount, category, address, phone, hasWebsite, website, sponsored, placeId, fid, lat, lng }] }. hasWebsite is null when the card does not show it (the usual case in list view); use gmaps_get_place or gmaps_find_leads to verify.',
  inputSchema: {
    query: z.string().min(1).describe('e.g. "barber shop in Lviv"'),
    limit: z.number().int().min(1).max(120).optional().describe('Default 20'),
    near: z.string().optional().describe('Appended as "near <place>"'),
    center: centerArg.optional(),
    radiusKm: z.number().min(0.1).max(50).optional().describe('With center: search at that point, add distanceKm to every card, drop cards beyond the radius (outOfRadius), sort by distance'),
    sort: z.enum(['distance', 'relevance']).optional().describe('With center: default distance'),
    jsonl: jsonlArg,
  },
}, tool(jsonlTool('search', 'card', (r, a) => (r.cards || []).map((c) => ({ ...c, query: a.query })), searchRun)));

server.registerTool('gmaps_get_place', {
  description: 'Full place details: { name, category, rating, reviewsCount, address, phone, website, hours { day: times }, plusCode, lat, lng, placeId, priceLevel, description, about, links { menu, booking, order }, social, claimed (false = "Claim this business" shown, a strong lead signal), photosCount, closed (permanent|temporary|null), activity { lastReviewAgo, lastReviewDays, recentReviews90d, ownerReplyRate, sampled } (from the newest ~10 reviews; skipped with activity:false), reviewTopics [{ topic, count }], ratingDistribution [{ stars, count }] (5..1), priceRange, services [{ name, price, description }], fromBusiness, locatedIn, photoCategories [names], popularTimes [{ day, hours: [{ hour, busyPct }] }] (best effort), links.services, placeUrl }. Every field may be null or empty.',
  inputSchema: { url: urlArg, activity: z.boolean().optional().describe('Sample the newest reviews for activity signals (default true; costs a few seconds)') },
}, tool(prepped('getPlace')));

server.registerTool('gmaps_get_reviews', {
  description: 'Reviews of a place: [{ author, rating, date, text, ownerReply }] after opening the Reviews tab, sorting, scrolling and expanding "More".',
  inputSchema: {
    url: urlArg,
    limit: z.number().int().min(1).max(200).optional().describe('Default 20'),
    sort: z.enum(['relevant', 'newest', 'highest', 'lowest']).optional().describe('Default relevant'),
    jsonl: jsonlArg,
  },
}, tool(jsonlTool('getReviews', 'review', (r) => (r.reviews || []).map((x, index) => ({ ...x, ...parsePlaceUrl(r.url), index, placeUrl: r.url })))));

server.registerTool('gmaps_get_photos', {
  description: 'Photo URLs of a place (full size, =s2048): { photos: [url] }. Only URLs; use gmaps_download_place to save files. Street View images are excluded unless `streetview` is true. `category` (e.g. "By owner", "Exterior", "Inside") opens that photo category first; the result lists the available `categories`.',
  inputSchema: {
    url: urlArg,
    limit: z.number().int().min(1).max(200).optional().describe('Default 30'),
    streetview: z.boolean().optional(),
    category: z.string().optional().describe('Photo category button, e.g. "By owner"'),
  },
}, tool(prepped('getPhotos')));

server.registerTool('gmaps_download_place', {
  description: 'Collect material for building a business website: place details + photos ("By owner" photos first, marked byOwner in place.json, then the rest) + reviews, saved to <dir or ~/gmaps-leads>/<name>-<id>/ as photos/NN.jpg, place.json and place.md (brief). Each browser step is its own queue job. Slow (polite 2-5 s delay per page); for long runs use gmaps_enqueue with tool "downloadPlace". Returns { folder, photos, reviews, warnings }.',
  inputSchema: {
    url: urlArg,
    dir: z.string().optional().describe('Output base directory; must be inside your home directory'),
    photos: z.number().int().min(0).max(200).optional().describe('Default 30'),
    reviews: z.number().int().min(0).max(200).optional().describe('Default 20'),
  },
}, tool(prepped('downloadPlace')));

server.registerTool('gmaps_find_leads', {
  description: 'Lead generation: for each area search "<query> in <area>", open every card without a real website, classify no_website | social_only (facebook/instagram/linktr.ee/tiktok/wa.me/g.page...) | weak_website (site-builder/template subdomains like wixsite.com, tilda.ws, business.site, sites.google.com, *.prom.ua, and booking-only pages like booksy.com, alteg.io) | has_website (shortener links are resolved first), and save the first three as leads to ~/.gmaps-mcp/leads.jsonl (status "new"; already tracked places are not re-opened). Places whose address is outside the area are dropped (strictArea, stats.outOfArea). Instead of areas you can pass center + radiusKm: the viewport of the circle is searched in tiles and places beyond the radius are dropped (stats.outOfRadius); leads get distanceKm. Each lead gets leadScore (0-100: no website 40, reviews up to 30, rating up to 15, unclaimed 10, phone 5, recent reviews +5, none for a year -15, owner replies +5; closed 0) and leadReasons; leads are sorted by score, then reviews. Slow: ~5-10 s per place. For many areas use gmaps_enqueue with tool "findLeads" and read the result with gmaps_queue get.',
  inputSchema: {
    query: z.string().min(1).describe('e.g. "dentist"'),
    areas: z.array(z.string()).max(30).optional().describe('e.g. ["Lviv", "Kyiv"]. Give exactly one of areas or center + radiusKm'),
    center: centerArg.optional(),
    radiusKm: z.number().min(0.1).max(50).optional().describe('With center: only places within this distance (their distanceKm is saved); strictArea does not apply'),
    limit: z.number().int().min(1).max(120).optional().describe('Search results per area, default 40'),
    includeWeakWebsites: z.boolean().optional().describe('Also keep social_only and weak_website leads (default true)'),
    jsonl: jsonlArg,
    grid: z.number().int().min(1).max(6).optional().describe('Search a grid x grid set of map tiles of the viewport (areas: default 1 = one search per area; center: default 1 if radiusKm <= 2, 2 if <= 5, else 3)'),
    strictArea: z.boolean().optional().describe('Drop places whose address does not contain the area name, also transliterated from Ukrainian (default true)'),
  },
}, tool(jsonlTool('findLeads', 'lead', (r) => r.leads || [])));

server.registerTool('gmaps_competitors', {
  description: 'Competitors of a business from its "People also search for" section: { name, competitors: [{ name, placeUrl, rating, reviewsCount, category }] }. With checkWebsites each competitor is opened (one queue job each) and gets website, websiteResolved and classification (no_website | social_only | weak_website | has_website); the result counts withWebsite. Use for the pitch "your competitors nearby have websites". Slow with checkWebsites; for long runs use gmaps_enqueue with tool "competitors".',
  inputSchema: {
    url: urlArg,
    limit: z.number().int().min(1).max(30).optional().describe('Default 10'),
    checkWebsites: z.boolean().optional().describe('Open every competitor and classify its website (default false)'),
    jsonl: jsonlArg,
  },
}, tool(jsonlTool('competitors', 'competitor', (r) => r.competitors || [])));

server.registerTool('gmaps_place_at', {
  description: 'What is at a coordinate? Maps shows only a plus code and locality for a bare point, so this reads those, then opens the map at zoom 20 there and clicks the center of the map, which selects the place exactly at the point. Returns { lat, lng, plusCode, locality, place { name, placeUrl, fid, lat, lng, distanceKm } or null, nearest }. `query` additionally searches around the point (zoom 18; nearest = up to 10 cards with distanceKm); `nearby` does the same only when the click found no place (query defaults to "shop"), and then place = the nearest card within radiusM. With details the place is also opened (place.details). Slow: each browser step is a queue job; gmaps_enqueue tool "placeAt" also works.',
  inputSchema: {
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    query: z.string().optional().describe('Also search for this around the point (fills nearest)'),
    nearby: z.boolean().optional().describe('If the click finds no place, search around the point (query or "shop")'),
    radiusM: z.number().min(1).max(5000).optional().describe('Default 60; used for the nearby fallback'),
    details: z.boolean().optional().describe('Also open the found place (gmaps_get_place)'),
  },
}, tool(prepped('placeAt')));

server.registerTool('gmaps_leads', {
  description: 'Local lead tracker (~/.gmaps-mcp/leads.jsonl, no browser). list: leads, optionally by status. update: set newStatus and/or note on lead `id`. Check this before contacting anyone so no business is contacted twice.',
  inputSchema: {
    action: z.enum(['list', 'update']),
    status: z.enum(STATUSES).optional().describe('list filter'),
    id: z.string().optional().describe('Lead id from list (update)'),
    newStatus: z.enum(STATUSES).optional(),
    note: z.string().max(2000).optional(),
    jsonl: jsonlArg.describe('list only: also write laya-cli JSONL rows (true or a path inside your home directory); adds jsonlPath and jsonlRows'),
  },
}, tool(({ action, status, id, newStatus, note, jsonl }) => {
  const list = loadLeads(LEADS_FILE);
  if (action === 'list') {
    const all = ranked(list.filter((l) => !status || l.status === status)); // computed on the fly, so old records are scored too
    return { count: all.length, file: LEADS_FILE, leads: all.map(brief), ...emitJsonl(jsonl, 'lead', all) };
  }
  if (!id) throw new Error('id required');
  if (!newStatus && note == null) throw new Error('newStatus or note required');
  const r = updateLead(list, { id, newStatus, note });
  saveLeads(LEADS_FILE, r.list);
  return brief(r.lead);
}));

server.registerTool('gmaps_check_website', {
  description: 'Fetch a website (no scripts run, 10 s timeout, 2 MB cap): { reachable, status, finalUrl, https, mobileFriendly (viewport meta), title, copyrightYear, outdatedHint, placeholder (social|builder|null), lastModified }. A dead or outdated site is also a lead.',
  inputSchema: { url: z.string().min(3) },
}, tool(checkWebsite));

server.registerTool('gmaps_export_leads', {
  description: 'Write leads to a CSV or JSON file (default ~/gmaps-leads/leads-<date>.csv). Path must be inside your home directory.',
  inputSchema: {
    status: z.enum(STATUSES).optional(),
    format: z.enum(['csv', 'json', 'jsonl']).optional().describe('Default csv; jsonl = laya-cli rows'),
    path: z.string().optional(),
  },
}, tool(({ status, format = 'csv', path: p }) => {
  const rows = ranked(loadLeads(LEADS_FILE).filter((l) => !status || l.status === status));
  const file = p ? underHome(p) : path.join(os.homedir(), 'gmaps-cli-leads', `leads-${new Date().toISOString().slice(0, 10)}.${format}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (format === 'jsonl') writeJsonl(file, rows.map((l) => toJsonlRow('lead', l)));
  else fs.writeFileSync(file, format === 'csv' ? toCsv(rows.map((l) => ({ ...l, leadReasons: l.leadReasons.join('; ') })), COLS) : JSON.stringify(rows, null, 2));
  return { path: file, count: rows.length };
}));

server.registerTool('gmaps_snapshot', {
  description: 'Compact list of visible interactive elements of the Maps tab with indexes: [{ index, role, label, text, href }]. Use to debug or drive custom flows with gmaps_click.',
}, tool(() => call('snapshot')));

server.registerTool('gmaps_read_page', {
  description: 'URL and visible text lines of the Maps tab.',
  inputSchema: { maxLines: z.number().int().min(1).max(1000).optional().describe('Default 200') },
}, tool(prepped('readPage')));

server.registerTool('gmaps_click', {
  description: 'Click an element of the Maps tab by index (from gmaps_snapshot, take the snapshot right before), CSS selector, or aria-label/visible text.',
  inputSchema: { index: z.number().int().min(0).optional(), selector: z.string().optional(), text: z.string().optional() },
}, tool((a) => {
  if ([a.index, a.selector, a.text].filter((v) => v !== undefined).length !== 1) throw new Error('Give exactly one of index, selector, text');
  return call('click', a);
}));

server.registerTool('gmaps_scroll', {
  description: 'Scroll a container of the Maps tab to its bottom `times` times (default feed: [role=feed], else the page).',
  inputSchema: { selector: z.string().optional(), times: z.number().int().min(1).max(50).optional().describe('Default 3') },
}, tool(prepped('scroll')));

server.registerTool('gmaps_enqueue', {
  description: 'Queue an action for the single background worker and return immediately: { jobId, status }. Runs at priority 0 (after any direct tool call), only while Chrome is connected, and survives restarts. `tool` is the internal handler name (search, getPlace, getReviews, getPhotos, getCompetitors, getPoint, clickPoi, downloadPlace, findLeads, competitors, placeAt, readPage, snapshot, click, scroll). Composite tools (findLeads, downloadPlace, competitors, placeAt) queue each browser step as its own job; after a restart they run again from the start (known leads are skipped). A repeated `key` returns the existing job unless it failed or was cancelled. Inspect with gmaps_queue.',
  inputSchema: {
    tool: z.string().describe('Internal handler name, e.g. "findLeads"'),
    args: z.record(z.string(), z.unknown()).optional().describe('Same arguments as the matching gmaps_* tool'),
    notBefore: z.union([z.number(), z.string()]).optional().describe('Earliest run time: ISO 8601 string or epoch ms'),
    key: z.string().optional().describe('Idempotency key'),
  },
}, tool(({ tool: name, args = {}, notBefore, key }) => {
  if (!HANDLERS.has(name)) throw new Error(`Unknown tool "${name}". Known: ${[...HANDLERS].join(', ')}`);
  const nb = typeof notBefore === 'string' ? Date.parse(notBefore) : notBefore;
  if (Number.isNaN(nb)) throw new Error('notBefore must be ISO 8601 or epoch ms');
  // ponytail: only URL/dir/query args are checked here; other args fail in the extension if malformed.
  return call('@enqueue', { tool: name, args: prep[name] ? prep[name](args) : args, notBefore: nb, key });
}));

server.registerTool('gmaps_queue', {
  description: 'Inspect the action queue. list: jobs newest first (optionally by status), get: one job with its result, cancel: cancel a queued job (a running one cannot be stopped). Statuses: queued, running, done, failed, unverified (a click that may have happened), cancelled. Steps of composite jobs have `parent`. The attempt log is ~/.gmaps-mcp/actions.jsonl.',
  inputSchema: {
    action: z.enum(['list', 'get', 'cancel']),
    id: z.number().int().optional().describe('Job id for get / cancel'),
    status: z.enum(['queued', 'running', 'done', 'failed', 'unverified', 'cancelled']).optional(),
    limit: z.number().int().min(1).max(500).optional().describe('Default 50'),
  },
}, tool((args) => call('@queue', args)));

let activeCalls = 0;
const api = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.headers.origin) { res.writeHead(403); res.end(JSON.stringify({ error: 'Origin forbidden' })); return; }
  if (shuttingDown) { res.writeHead(503); res.end(JSON.stringify({ error: 'Service shutting down' })); return; }
  if (req.method === 'POST' && req.url === '/stop') {
    if (!q || activeCalls || [...q.jobs.values()].some(job => job.status === 'running')) {
      res.writeHead(409); res.end(JSON.stringify({ error: 'Service has active work; retry after it finishes' })); return;
    }
    shuttingDown = true;
    res.end(JSON.stringify({ stopped: true }));
    res.on('finish', () => process.exit(0));
    return;
  }
  if (req.method === 'GET' && req.url === '/commands') {
    res.end(JSON.stringify(catalog())); return;
  }
  if (req.method !== 'POST' || req.url !== '/call') { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
  try {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 1024 * 1024) throw new Error('Request too large'); }
    const { name, args = {} } = JSON.parse(body);
    const entry = registry.get(name);
    if (!entry) throw new Error('Unknown command');
    const parsed = z.object(entry.inputSchema || {}).strict().parse(args);
    activeCalls++;
    let result;
    try { result = await entry.handler(parsed); } finally { activeCalls--; }
    if (result.isError) throw new Error(result.content?.[0]?.text || 'Command failed');
    res.end(result.content[0].text);
  } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
});
api.on('error', (error) => { console.error(`[gmaps-cli] API error: ${error.message}`); process.exit(1); });
function catalog() {
  return [...registry].map(([name, spec]) => ({ name, description: spec.description,
    options: Object.entries(spec.inputSchema || {}).map(([key, schema]) => ({ key, required: !schema.isOptional(), description: schema.description, schema: z.toJSONSchema(schema) })) }));
}
if (process.argv.includes('--catalog')) process.stdout.write(JSON.stringify(catalog()), () => process.exit(0));
else api.listen(Number(process.env.GMAPS_CLI_API_PORT) || 47833, '127.0.0.1');
