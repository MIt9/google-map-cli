// Google Maps MCP Bridge — service worker.
// Talks to the local MCP server over WebSocket and reads Google Maps in ONE dedicated background tab with
// chrome.scripting.executeScript (no debugger). Read-only: nothing is posted, clicked-through or submitted.

const WS_URL = 'ws://127.0.0.1:47832';

// ---------- WebSocket link to MCP server ----------

let ws = null;

// Must equal mcp-server/package.json "version"; bump both together on every change.
const VERSION = chrome.runtime.getManifest().version;

async function connect() {
  if (ws && ws.readyState <= WebSocket.OPEN) return;
  const sock = (ws = new WebSocket(WS_URL));
  sock.onopen = async () => {
    setConnected(true);
    const { halted } = await chrome.storage.local.get('halted');
    sock.send(JSON.stringify({ type: 'hello', version: VERSION, halted: halted?.reason || null }));
  };
  sock.onmessage = async ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.type === 'ping') return sock.send('{"type":"pong"}');
    if (msg.type === 'hello') {
      await chrome.storage.local.set({ serverVersion: msg.version });
      if (msg.version !== VERSION) chrome.action.setBadgeText({ text: '!' });
      return;
    }
    const logId = await logStart(msg.tool, msg.args || {});
    try {
      const handler = handlers[msg.tool];
      if (!handler) throw new Error(`Unknown tool: ${msg.tool}`);
      const result = await handler(msg.args || {});
      await logEnd(logId, { status: 'ok', result: summarizeResult(result) });
      sock.send(JSON.stringify({ id: msg.id, result }));
    } catch (e) {
      const error = String(e?.message || e);
      await logEnd(logId, { status: 'error', error });
      sock.send(JSON.stringify({ id: msg.id, error }));
    }
  };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    setConnected(false);
  };
}

// ---------- Status + history (shown in popup) ----------

const HISTORY_MAX = 100;

function setConnected(on) {
  chrome.storage.local.set({ connected: on, connectedChangedAt: Date.now(), ...(on ? {} : { serverVersion: null }) });
  chrome.action.setBadgeText({ text: on ? 'on' : 'off' });
  chrome.action.setBadgeBackgroundColor({ color: on ? '#1e8e3e' : '#9aa0a6' });
}

// History writes are read-modify-write; serialize them so parallel tools don't drop entries.
let historyChain = Promise.resolve();
function mutateHistory(fn) {
  historyChain = historyChain.then(async () => {
    const { history = [] } = await chrome.storage.local.get('history');
    await chrome.storage.local.set({ history: fn(history).slice(0, HISTORY_MAX) });
  }).catch(() => {});
  return historyChain;
}

const summarizeArgs = (a) => [a.query, a.near && `near ${a.near}`, a.url, a.selector, a.text, a.index != null && `#${a.index}`]
  .filter(Boolean).join(' · ').slice(0, 120);

function summarizeResult(r) {
  if (r?.cards) return `${r.cards.length} places`;
  if (r?.reviews) return `${r.reviews.length} reviews`;
  if (r?.photos) return `${r.photos.length} photos`;
  if (r?.competitors) return `${r.competitors.length} competitors`;
  if (r?.name) return r.name;
  if (Array.isArray(r)) return `${r.length} items`;
  return '';
}

async function logStart(tool, args) {
  const id = crypto.randomUUID();
  await mutateHistory((h) => [{ id, tool, summary: summarizeArgs(args), startedAt: Date.now(), status: 'running' }, ...h]);
  return id;
}

const logEnd = (id, patch) => mutateHistory((h) => h.map((e) => (e.id === id ? { ...e, ...patch, endedAt: Date.now() } : e)));

// A service worker restart kills in-flight work.
mutateHistory((h) => h.map((e) => (e.status === 'running' ? { ...e, status: 'error', error: 'Interrupted (extension restarted)' } : e)));

// Tell the server when a halt starts or the popup's Resume clears it (it refuses new work while halted).
chrome.storage.onChanged.addListener((ch) => {
  if (!ch.halted) return;
  const reason = ch.halted.newValue?.reason || null;
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'halted', reason }));
  if (reason) { chrome.action.setBadgeText({ text: 'halt' }); chrome.action.setBadgeBackgroundColor({ color: '#d93025' }); }
  else chrome.storage.local.get('connected').then(({ connected }) => setConnected(!!connected));
});

// ---------- Page functions ----------
// Injected into the Maps tab: each must be fully self-contained (no closures over this file).
// Google's classes are obfuscated and change; these rely on roles, aria-labels, data-item-id and text.
// Every field is optional: a missing element yields null, never an exception.

// Captcha / consent / "unusual traffic" detector. Returns a reason string or null.
function pgSafe() {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width >= 100 && r.height >= 50; };
  if (location.hostname === 'consent.google.com') return 'consent wall (consent.google.com)';
  if (/^\/sorry\b/.test(location.pathname)) return 'Google "sorry" page (unusual traffic)';
  if ([...document.querySelectorAll('iframe')].some((f) => /recaptcha|captcha/i.test(f.src || '') && vis(f))) return 'captcha challenge';
  const RE = /unusual traffic|not a robot|before you continue to google|verify it'?s you/i;
  // Only dialogs and short pages are scanned, so a review mentioning these words doesn't trip it.
  const srcs = [...document.querySelectorAll('[role=dialog],[role=alertdialog],form[action*="consent"]')];
  if ((document.body?.innerText || '').length < 2500) srcs.push(document.body);
  for (const e of srcs) { const m = (e?.innerText || '').match(RE); if (m) return m[0]; }
  return null;
}

// Search result cards in [role=feed]; null while the feed is absent.
function pgCards() {
  const feed = document.querySelector('[role=feed]');
  if (!feed) return null;
  const unwrap = (h) => {
    try { const u = new URL(h, location.href); return u.hostname.endsWith('google.com') && u.pathname === '/url' ? u.searchParams.get('q') || h : u.href; } catch { return null; }
  };
  const num = (s) => {
    const m = String(s || '').replace(/,/g, '').match(/([\d.]+)\s*([KkMm])?/);
    return m ? Math.round(parseFloat(m[1]) * ({ k: 1e3, m: 1e6 }[(m[2] || '').toLowerCase()] || 1)) : null;
  };
  const seen = new Set();
  const cards = [];
  for (const a of feed.querySelectorAll('a[href*="/maps/place/"]')) {
    if (seen.has(a.href)) continue;
    seen.add(a.href);
    const box = a.closest('[role=article]') || a.parentElement || a;
    // Visited places carry a "· Visited link" marker, in the label and as a line of its own.
    const VISITED = /\s*[·⋅]\s*Visited link\s*$/i;
    const lines = (box.innerText || '').split('\n').map((l) => l.replace(VISITED, '').trim()).filter((l) => l && !/^Visited link$/i.test(l));
    const star = box.querySelector('[role=img][aria-label*="star" i]')?.getAttribute('aria-label') || '';
    // Rating line "4.5(120)" or aria-label "4.5 stars 120 Reviews".
    const rt = lines.join(' ').match(/(\d\.\d)\s*\(([\d,.]+[KkMm]?)\)/);
    const rating = parseFloat(star.match(/[\d.]+/)?.[0] ?? rt?.[1]) || null;
    const reviewsCount = num(star.match(/stars?\s*([\d,]+)/i)?.[1] ?? rt?.[2]);
    // "Category · Address" line (Maps separates with · and ⋅); skip hours/service lines.
    const info = lines.find((l) => /[·⋅]/.test(l) && !/^(Open|Closed|Closes|Opens|Dine|Takeout|Delivery|Drive|No |Sponsored)/i.test(l) && !/^\d\.\d/.test(l));
    const parts = (info || '').split(/[·⋅]/).map((s) => s.trim()).filter((s) => s && !/^\${1,4}$/.test(s) && !/^[\d–-]+$/.test(s));
    const phone = lines.map((l) => l.split(/[·⋅]/).pop().trim()).find((s) => /^\+?[\d(][\d\s().-]{6,}\d$/.test(s)) || null;
    const w = box.querySelector('a[aria-label*="website" i], a[data-value="Website"]');
    cards.push({
      name: (a.getAttribute('aria-label') || '').replace(VISITED, '').trim() || lines[0] || null,
      placeUrl: a.href,
      rating,
      reviewsCount,
      category: parts[0] || null,
      address: parts[1] || null,
      phone,
      hasWebsite: w ? true : null, // list cards usually omit the website; null = unknown, not "none"
      website: w ? unwrap(w.href) : null,
      sponsored: lines.some((l) => /^(Sponsored|Ad)$/i.test(l)),
    });
  }
  return { cards, end: /You['’]ve reached the end of the list/i.test(feed.innerText) };
}

// True once a place panel is there: 'full' (h1 + info rows), 'h1', or null.
function pgPlaceReady() {
  const h1 = [...document.querySelectorAll('h1')].find((h) => h.innerText.trim() && !/^results$/i.test(h.innerText.trim()));
  return h1 ? (document.querySelector('[data-item-id]') ? 'full' : 'h1') : null;
}

function pgPlace() {
  const T = (e) => (e?.innerText || '').replace(/\s+/g, ' ').trim();
  const TC = (e) => (e?.textContent || '').replace(/\s+/g, ' ').trim(); // also works for hidden (collapsed) nodes
  const lab = (sel, re) => (document.querySelector(sel)?.getAttribute('aria-label') || '').replace(re, '').trim() || null;
  const unwrap = (h) => {
    try { const u = new URL(h, location.href); return u.hostname.endsWith('google.com') && u.pathname === '/url' ? u.searchParams.get('q') || h : u.href; } catch { return null; }
  };
  const num = (s) => {
    const m = String(s || '').replace(/,/g, '').match(/([\d.]+)\s*([KkMm])?/);
    return m ? Math.round(parseFloat(m[1]) * ({ k: 1e3, m: 1e6 }[(m[2] || '').toLowerCase()] || 1)) : null;
  };
  const h1 = [...document.querySelectorAll('h1')].find((h) => T(h) && !/^results$/i.test(T(h)));
  const head = T(h1?.closest('[role=main]') || document.body).slice(0, 1500);
  const labels = [...document.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label'));

  const stars = labels.find((l) => /^[\d.]+ stars?\b/i.test(l));
  const rt = head.match(/(\d\.\d)\s*\(([\d,.]+[KkMm]?)\)/);
  const rating = parseFloat(stars?.match(/[\d.]+/)?.[0] ?? rt?.[1]) || null;
  const reviewsCount = num(labels.find((l) => /^[\d,]+ reviews?$/i.test(l)) ?? rt?.[2]);

  const phoneEl = document.querySelector('[data-item-id^="phone:tel:"]');
  const website = document.querySelector('a[data-item-id="authority"]');

  // Hours: table rows (present even when collapsed), else the aria-label "Monday, 9 AM to 5 PM; ...".
  const hours = {};
  for (const tr of document.querySelectorAll('table tr')) {
    const c = tr.querySelectorAll('td');
    const d = TC(c[0]);
    if (c[1] && /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i.test(d)) {
      hours[d] = [...c[1].querySelectorAll('li')].map(TC).filter(Boolean).join(', ') || TC(c[1]);
    }
  }
  if (!Object.keys(hours).length) {
    const l = document.querySelector('[data-item-id="oh"] [aria-label], [aria-label*="open hours" i], [aria-label*="Hours" i]')?.getAttribute('aria-label') || '';
    for (const seg of l.split(/;|\. /)) {
      const m = seg.trim().match(/^((?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day),?\s*(.+)$/i);
      if (m) hours[m[1]] = m[2].trim();
    }
  }

  const links = { menu: null, booking: [], order: [] };
  for (const a of document.querySelectorAll('a[data-item-id]')) {
    const id = a.getAttribute('data-item-id');
    const text = `${id} ${a.getAttribute('aria-label') || ''}`;
    const href = unwrap(a.href);
    if (!href || id === 'authority' || /google\.com\/(maps|search)/.test(href)) continue;
    if (id === 'menu') links.menu = href;
    else if (/reserv|appointment|book/i.test(text)) links.booking.push(href);
    else if (/order|delivery|pickup/i.test(text) || id.startsWith('action:')) links.order.push(href);
  }
  for (const a of document.querySelectorAll('a[aria-label*="Reserve" i], a[aria-label*="Book" i], a[aria-label*="Make an appointment" i]')) {
    const href = unwrap(a.href);
    if (href && !/google\.com\/(maps|search)/.test(href) && !links.booking.includes(href)) links.booking.push(href);
  }

  const SOCIAL = /(facebook|instagram|twitter|tiktok|youtube|linkedin|pinterest|telegram|viber)\.com|(^|\.)(x\.com|t\.me|wa\.me|linktr\.ee|fb\.com|fb\.me)$/i;
  const social = [...new Set([...document.querySelectorAll('a[href]')].map((a) => unwrap(a.href)).filter((h) => {
    try { return SOCIAL.test(new URL(h).hostname); } catch { return false; }
  }))];

  const lines = (document.body.innerText || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 120);
  const closed = lines.map((l) => l.match(/^(Permanently|Temporarily) closed\b/i)).find(Boolean);
  const claimEl = document.querySelector('[aria-label*="Claim this business" i], [data-item-id="merchant"]');
  const claimText = /claim this business|own this business\?/i.test(document.body.innerText || '');

  return {
    name: T(h1) || null,
    category: T(document.querySelector('button[jsaction*="category"]')) || T(document.querySelector('.DkEaL')) || null,
    rating,
    reviewsCount,
    address: lab('[data-item-id="address"]', /^Address:\s*/i),
    phone: lab('[data-item-id^="phone:tel:"]', /^Phone:\s*/i) || phoneEl?.getAttribute('data-item-id').replace(/^phone:tel:/, '') || null,
    website: website ? unwrap(website.href) : null,
    hours,
    plusCode: lab('[data-item-id="oloc"]', /^Plus code:\s*/i),
    priceLevel: lab('[aria-label^="Price:" i]', /^Price:\s*/i) || [...document.querySelectorAll('span')].map(T).find((t) => /^\${1,4}$/.test(t)) || null,
    description: T(document.querySelector('.PYvSYb')) || null,
    links,
    social,
    claimed: h1 ? !(claimEl || claimText) : null,
    photosCount: num(lines.map((l) => l.match(/^([\d,]+)\+?\s+photos?$/i)?.[1]).find(Boolean) ?? labels.map((l) => l.match(/^([\d,]+)\+?\s+photos?$/i)?.[1]).find(Boolean)),
    closed: closed ? closed[1].toLowerCase() === 'permanently' ? 'permanent' : 'temporary' : null,
  };
}

// "About" tab: { "Service options": ["Dine-in", ...], ... } from h2 sections.
function pgAbout() {
  const out = {};
  const root = document.querySelector('[role=tabpanel]') || document.querySelector('[role=main]') || document;
  for (const h of root.querySelectorAll('h2')) {
    const name = (h.innerText || '').trim();
    if (/^(results|map tools|map type|map details|layers)\b/i.test(name)) continue; // map UI, not the place
    // Leading non-letters are icon glyphs / spaces.
    const items = [...new Set([...(h.parentElement?.querySelectorAll('li') || [])]
      .map((l) => (l.getAttribute('aria-label') || l.innerText || '').replace(/\s+/g, ' ').replace(/^[^\p{L}\p{N}]+/u, '').trim()).filter(Boolean))];
    if (name && items.length) out[name] = items;
  }
  return out;
}

// Review topics, rating distribution, price range, "From the business", "Located in", services link, popular times.
// Everything is optional (each part in its own try); lists are arrays because executeScript sorts object keys.
function pgExtras() {
  const T = (e) => (e?.innerText || '').replace(/\s+/g, ' ').trim();
  const num = (x) => { const n = parseInt(String(x || '').replace(/\D/g, ''), 10); return Number.isFinite(n) ? n : null; };
  const out = { reviewTopics: [], ratingDistribution: [], priceRange: null, fromBusiness: null, locatedIn: null, servicesLink: null, popularTimes: [] };
  const labelled = [...document.querySelectorAll('[aria-label]')];
  try { // "polite staff, mentioned in 6 reviews"; "All reviews" does not match
    const seen = new Set();
    for (const e of document.querySelectorAll('[role=radio][aria-label]')) {
      const m = e.getAttribute('aria-label').match(/^(.*?),\s*mentioned in ([\d,]+) reviews?$/i);
      if (m && !seen.has(m[1].toLowerCase())) { seen.add(m[1].toLowerCase()); out.reviewTopics.push({ topic: m[1].trim(), count: num(m[2]) }); }
    }
  } catch { /* optional */ }
  try { // "5 stars, 100 reviews"
    const d = new Map();
    for (const e of labelled) {
      const m = e.getAttribute('aria-label').match(/^(\d)\s+stars?,\s*([\d,]+)\s+reviews?$/i);
      if (m && !d.has(+m[1])) d.set(+m[1], num(m[2]));
    }
    out.ratingDistribution = [5, 4, 3, 2, 1].filter((n) => d.has(n)).map((n) => ({ stars: n, count: d.get(n) }));
  } catch { /* optional */ }
  try {
    const main = document.querySelector('[role=main]') || document.body;
    const lbl = [...main.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')).find((l) => /\bprice\b/i.test(l) && /[₴$€£]/.test(l));
    out.priceRange = lbl ? lbl.replace(/^.*?price[^:]*:\s*/i, '').trim()
      : [...main.querySelectorAll('span,div')].filter((e) => !e.children.length).map(T)
        .find((t) => t.length <= 20 && (/^[₴$€£]{1,4}$/.test(t) || /^[₴$€£]\s?\d[\d\s,.]*(?:[–-]\s?[₴$€£]?\s?\d[\d\s,.]*)?\+?$/.test(t))) || null;
  } catch { /* optional */ }
  try {
    const hd = [...document.querySelectorAll('h2,h3,div,span')].find((e) => !e.children.length && /^from the business$/i.test(T(e)));
    for (let p = hd?.parentElement, i = 0; p && i < 3; p = p.parentElement, i++) {
      const t = T(p).replace(/^from the business\s*/i, '').trim();
      if (t) { out.fromBusiness = t.slice(0, 2000); break; }
    }
  } catch { /* optional */ }
  try {
    out.locatedIn = (document.querySelector('[data-item-id="locatedin"]')?.getAttribute('aria-label') || '').replace(/^Located in:\s*/i, '').trim()
      || (document.body.innerText.match(/^Located in:\s*(.+)$/m)?.[1] || '').trim() || null;
  } catch { /* optional */ }
  try {
    const a = document.querySelector('a[aria-label="Open services link"]');
    if (a) { const u = new URL(a.href, location.href); out.servicesLink = u.hostname.endsWith('google.com') && u.pathname === '/url' ? u.searchParams.get('q') || a.href : u.href; }
  } catch { /* optional */ }
  try { // 7 groups (Sunday..Saturday, no day labels in the DOM), each the parent of the hourly bars "0% busy at 6 am."
    const groups = new Map();
    for (const e of labelled) {
      const m = e.getAttribute('aria-label').match(/(\d+)%\s+busy\s+at\s+(.+?)\.?$/i);
      if (!m || !e.parentElement) continue;
      if (!groups.has(e.parentElement)) groups.set(e.parentElement, []);
      groups.get(e.parentElement).push({ hour: m[2].trim(), busyPct: +m[1] });
    }
    const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    out.popularTimes = [...groups].map(([el, hours], i) => ({ day: groups.size === 7 ? DAYS[i] : null, today: el.offsetParent !== null, hours }));
  } catch { /* optional */ }
  return out;
}

// Photo category buttons (All, Exterior, Inside, Videos, By owner, ...). Overview: row = button.parentElement.parentElement.
function pgPhotoCategories() {
  const all = [...document.querySelectorAll('button[aria-label="All"]')];
  const first = all.find((b) => b.closest('[role=main]')) || all[0];
  const count = (el) => el?.querySelectorAll('button[aria-label]').length || 0;
  let box = first?.parentElement?.parentElement;
  if (count(box) < 2) { // gallery layout: nearest ancestor holding several buttons
    box = first?.parentElement;
    while (box && count(box) < 2) box = box.parentElement;
  }
  return [...new Set([...(box?.querySelectorAll('button[aria-label]') || [])].map((b) => b.getAttribute('aria-label').trim()).filter(Boolean))];
}

// Services / Menu / Products tab: rows with a name, price and description.
function pgServices() {
  const panel = document.querySelector('[role=tabpanel]');
  const root = panel || document.querySelector('[role=main]') || document.body;
  const PRICE = /[₴$€£]|\d\s?(?:грн|UAH|USD|EUR|PLN|zł)\b|\bfrom\s+\d/i;
  const out = [];
  const seen = new Set();
  for (const r of root.querySelectorAll('li, [role=listitem]')) {
    const lines = (r.innerText || '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length || lines.length > 8) continue;
    const price = lines.find((l) => PRICE.test(l) && l.length <= 40) || null;
    const name = lines.find((l) => l !== price) || null;
    if (!name || (!panel && !price)) continue; // without a tab panel only priced rows are trustworthy
    const k = name + '|' + price;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ name, price, description: lines.filter((l) => l !== name && l !== price).join(' ') || null });
  }
  return out.slice(0, 100);
}

// "People also search for": <h2> + items (div[role=link], no href) in h2.parentElement.nextElementSibling.
// Returns null when the section is absent, else the parsed items; label "Name · 5.0 stars · 289 reviews · Barber shop".
function pgCompetitorItems() {
  const h = [...document.querySelectorAll('h2')].find((e) => /^people also search for$/i.test((e.innerText || '').trim()));
  if (!h) return null;
  const num = (x) => { const n = parseInt(String(x || '').replace(/\D/g, ''), 10); return Number.isFinite(n) ? n : null; };
  return [...(h.parentElement?.nextElementSibling?.querySelectorAll('[role=link]') || [])].map((el, index) => {
    const parts = (el.getAttribute('aria-label') || '').split(' · ').map((p) => p.trim()).filter(Boolean);
    const st = parts.findIndex((p, i) => i > 0 && /^[\d.]+\s+stars?$/i.test(p));
    const rv = parts.findIndex((p, i) => i > 0 && /^[\d,]+\s+reviews?$/i.test(p));
    const rest = parts.slice(Math.max(st, rv) + 1);
    return {
      index,
      name: parts[0] || null,
      rating: st > 0 ? parseFloat(parts[st]) || null : null,
      reviewsCount: rv > 0 ? num(parts[rv]) : null,
      category: (Math.max(st, rv) > 0 ? rest : parts.slice(1)).join(' · ') || null,
    };
  });
}

// Click the competitor item with this name (re-found by name each time: the section re-renders and may reorder).
function pgCompetitorClick(name) {
  const h = [...document.querySelectorAll('h2')].find((e) => /^people also search for$/i.test((e.innerText || '').trim()));
  const el = [...(h?.parentElement?.nextElementSibling?.querySelectorAll('[role=link]') || [])]
    .find((e) => (e.getAttribute('aria-label') || '').split(' · ')[0].trim() === name);
  if (!el) return false;
  el.scrollIntoView({ block: 'center' });
  el.click();
  return true;
}

// Activity sample: the first ~10 reviews (the list is sorted by Newest): [{ date, replied }].
function pgActivity() {
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('[data-review-id]')) {
    const id = el.getAttribute('data-review-id');
    if (el.parentElement?.closest('[data-review-id]') || seen.has(id)) continue;
    seen.add(id);
    const lines = (el.innerText || '').split('\n').map((l) => l.trim()).filter(Boolean);
    out.push({
      date: (el.querySelector('.rsqaWe')?.innerText || '').trim() || lines.find((l) => /\bago\b|^Edited/i.test(l)) || null,
      replied: !!el.querySelector('.CDe7pd') || lines.some((l) => /^Response from the owner/i.test(l)),
    });
    if (out.length >= 10) break;
  }
  return out;
}

// Reviews: top-level [data-review-id] blocks.
function pgReviews() {
  const T = (e) => (e?.innerText || '').replace(/\s+/g, ' ').trim();
  const seen = new Set();
  const out = [];
  for (const el of document.querySelectorAll('[data-review-id]')) {
    const id = el.getAttribute('data-review-id');
    if (el.parentElement?.closest('[data-review-id]') || seen.has(id)) continue;
    seen.add(id);
    const lines = (el.innerText || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const reply = el.querySelector('.CDe7pd');
    const textEl = [...el.querySelectorAll('.wiI7pd')].find((e) => !e.closest('.CDe7pd'));
    const star = el.querySelector('[role=img][aria-label*="star" i]')?.getAttribute('aria-label') || '';
    let ownerReply = T(reply);
    if (!ownerReply) { // text fallback: lines after "Response from the owner"
      const i = lines.findIndex((l) => /^Response from the owner/i.test(l));
      if (i >= 0) ownerReply = lines.slice(i + 1).filter((l) => !/ago$/.test(l)).join(' ');
    }
    out.push({
      author: T(el.querySelector('.d4r55')) || el.querySelector('a[href*="/contrib/"]')?.getAttribute('aria-label') || lines[0] || null,
      rating: parseFloat(star.match(/[\d.]+/)?.[0]) || null,
      date: T(el.querySelector('.rsqaWe')) || lines.find((l) => /\bago\b|^Edited/i.test(l)) || null,
      text: T(textEl) || null,
      ownerReply: ownerReply.replace(/^Response from the owner\s*/i, '') || null,
    });
  }
  return out;
}

// Expand truncated review texts ("More"). Returns how many buttons were clicked.
function pgExpand() {
  let n = 0;
  for (const b of document.querySelectorAll('[data-review-id] button[aria-label="See more"], [data-review-id] button')) {
    if (b.dataset.gmExp) continue;
    b.dataset.gmExp = '1';
    const t = (b.getAttribute('aria-label') || b.innerText || '').trim();
    if (/^(See more|More)$/i.test(t)) { b.click(); n++; }
  }
  return n;
}

// Image URLs (user photos), raw as found; the caller normalises sizes.
function pgPhotos(streetview, gridOnly) {
  const RE = streetview
    ? /https:\/\/(?:lh\d+\.googleusercontent\.com|streetviewpixels-pa\.googleapis\.com)\/[^"')\s\\]+/g
    : /https:\/\/lh\d+\.googleusercontent\.com\/[^"')\s\\]+/g;
  const small = (u) => { const m = u.match(/=[ws](\d+)(?:-h(\d+))?/); return !!m && +m[1] <= 120 && (!m[2] || +m[2] <= 120); };
  const found = new Set();
  const add = (s) => { for (const u of String(s || '').match(RE) || []) if (!/\/(a|a-)\//.test(u) && !small(u)) found.add(u); };
  const roots = gridOnly ? [...document.querySelectorAll('a[data-photo-index]')] : [document];
  for (const root of roots) {
    for (const e of root.querySelectorAll('img[src], [style*="googleusercontent"], [style*="streetviewpixels"]')) {
      add(e.getAttribute('src'));
      add(e.getAttribute('style'));
    }
  }
  return [...found];
}

// Scroll a container to its bottom. `sel` = the container, else the nearest scrollable ancestor of the first `item`.
// Returns the number of distinct items (by `idAttr`, else by element) so the caller can detect "no more".
function pgScroll(sel, item, idAttr) {
  let el = sel ? document.querySelector(sel) : null;
  if (!el && item) {
    el = document.querySelector(item);
    while (el && !(el.scrollHeight > el.clientHeight + 5 && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
  }
  const box = el || document.scrollingElement;
  box.scrollTop = box.scrollHeight;
  const items = item ? [...document.querySelectorAll(item)] : [];
  return { count: idAttr ? new Set(items.map((e) => e.getAttribute(idAttr))).size : items.length, height: box.scrollHeight };
}

// Click first visible match: spec { selectors: [css...] } tried in order | { text } (aria-label/text, exact first) | { index }.
function pgClick(spec, interactive) {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const name = (e) => (e.getAttribute('aria-label') || e.innerText || '').replace(/\s+/g, ' ').trim();
  let el = null;
  for (const s of spec.selectors || []) { el = [...document.querySelectorAll(s)].find(vis); if (el) break; }
  if (!el && spec.text) {
    const t = spec.text.toLowerCase();
    const all = [...document.querySelectorAll(interactive)].filter(vis);
    el = all.find((e) => name(e).toLowerCase() === t) || all.find((e) => name(e).toLowerCase().includes(t));
  }
  if (!el && spec.index != null) el = [...document.querySelectorAll(interactive)].filter(vis)[spec.index];
  if (!el) return null;
  el.scrollIntoView({ block: 'center' });
  el.click();
  return name(el).slice(0, 80);
}

function pgSnapshot(interactive) {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return [...document.querySelectorAll(interactive)].filter(vis).map((e, index) => ({
    index,
    role: e.getAttribute('role') || e.tagName.toLowerCase(),
    label: e.getAttribute('aria-label') || null,
    text: (e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80) || null,
    href: e.href || null,
  })).slice(0, 400);
}

function pgText(maxLines) {
  return (document.body.innerText || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, maxLines);
}

// ---------- Tab + navigation ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);
const jitter = (min, max) => sleep(rand(min, max));

// Same set the server sends to pgClick/pgSnapshot as "interactive".
const INTERACTIVE = 'a,button,input,[role=button],[role=tab],[role=menuitem],[role=menuitemradio],[role=option],[data-item-id]';
const MAPS_RE = /^https:\/\/(www\.google\.com\/maps(\/|\?|$)|maps\.app\.goo\.gl\/|goo\.gl\/maps(\/|\?|$))/;
const isMapsHere = (u) => /^https:\/\/www\.google\.com\/maps(\/|\?|$)/.test(u || '');

// The one reusable tab: background, never focused (unless a halt needs the user).
async function mapsTabId(create = true) {
  const { mapsTab } = await chrome.storage.local.get('mapsTab');
  if (mapsTab) { const t = await chrome.tabs.get(mapsTab).catch(() => null); if (t) return t.id; }
  if (!create) throw new Error('No Maps tab yet: run gmaps_search or gmaps_get_place first');
  const t = await chrome.tabs.create({ url: 'about:blank', active: false });
  await chrome.storage.local.set({ mapsTab: t.id });
  return t.id;
}

async function exec(func, ...args) {
  const tabId = await mapsTabId(false);
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return r?.result;
}

// Polls func until ok(value); returns the last value (null/undefined on failure). Checks for a halt before giving up.
async function until(func, args, ok, timeout = 15000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await exec(func, ...args).catch(() => null);
    if (ok(v)) return v;
    if (Date.now() > end) { await assertSafe(); return v; }
    await sleep(500);
  }
}

// Captcha / consent wall / unusual traffic: stop everything until the user presses Resume in the popup.
async function assertSafe() {
  const tabId = await mapsTabId(false);
  const tab = await chrome.tabs.get(tabId);
  let reason = null;
  try {
    const u = new URL(tab.url || 'about:blank');
    if (u.hostname === 'consent.google.com') reason = 'consent wall (consent.google.com)';
    else if (/^\/sorry\b/.test(u.pathname)) reason = 'Google "sorry" page (unusual traffic)';
  } catch { /* about:blank etc. */ }
  reason ||= await exec(pgSafe).catch(() => null);
  if (!reason) return;
  await chrome.storage.local.set({ halted: { reason, at: Date.now() } });
  // Bring the tab forward so the user can solve it.
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  throw new Error(`HALT: Google shows "${reason}". Resolve it manually in the Maps tab, then press Resume in the extension popup.`);
}

// Polite pace: 2-5 s (random) between Maps page navigations.
let lastNav = 0;
let nextGap = rand(2000, 5000);

async function navigate(url) {
  const wait = lastNav + nextGap - Date.now();
  if (wait > 0) await sleep(wait);
  const tabId = await mapsTabId();
  await chrome.scripting.executeScript({ target: { tabId }, func: () => { window.__gmOld = true; } }).catch(() => {});
  await chrome.tabs.update(tabId, { url });
  lastNav = Date.now();
  nextGap = rand(2000, 5000);
  // The old document still reports "complete" for a moment; wait for a fresh document (marker gone).
  for (const end = Date.now() + 30000; Date.now() < end; await sleep(300)) {
    if ((await chrome.tabs.get(tabId)).status !== 'complete') continue;
    const old = await chrome.scripting.executeScript({ target: { tabId }, func: () => !!window.__gmOld }).then((r) => r[0]?.result, () => null);
    if (old !== true) break;
  }
  await jitter(800, 1500);
  await assertSafe();
}

const withHl = (u) => { const x = new URL(u); if (x.hostname === 'www.google.com') x.searchParams.set('hl', 'en'); return x.href; };

// Opens a Maps URL (short links are resolved by navigating) and makes sure the UI is English.
async function openMaps(url) {
  if (!MAPS_RE.test(url)) throw new Error(`Not a Google Maps URL: ${url}`);
  await navigate(withHl(url));
  let cur = (await chrome.tabs.get(await mapsTabId())).url;
  if (!isMapsHere(cur)) throw new Error(`URL did not resolve to Google Maps: ${cur}`);
  if (new URL(cur).searchParams.get('hl') !== 'en') await navigate(withHl(cur));
  cur = (await chrome.tabs.get(await mapsTabId())).url;
  return cur;
}

const click = (spec) => exec(pgClick, spec, INTERACTIVE);
const currentUrl = async () => (await chrome.tabs.get(await mapsTabId())).url;

// ---------- Tools ----------

// Feed already visible? Scroll until `limit`, the end marker, or no growth.
async function search({ query, limit = 20, near, at }) {
  if (at != null && !/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,\d+(\.\d+)?$/.test(at)) throw new Error(`Bad map position: ${at}`);
  const max = Math.min(limit, 120);
  const q = near ? `${query} near ${near}` : query;
  await openMaps(`https://www.google.com/maps/search/${encodeURIComponent(q)}${at ? `/@${at}z` : ''}?hl=en`); // `at` = "lat,lng,zoom": search around that map position (grid scan)
  let res = await until(pgCards, [], (v) => v !== null, 20000);
  if (!res) {
    // No feed: Maps jumped straight to one place (or nothing matched).
    if (!/\/maps\/place\//.test(await currentUrl())) return { query, count: 0, cards: [], note: 'no results' };
    await until(pgPlaceReady, [], (v) => v, 15000);
    const p = await exec(pgPlace);
    return {
      query, count: 1, note: 'single result',
      cards: [{ name: p.name, placeUrl: await currentUrl(), rating: p.rating, reviewsCount: p.reviewsCount, category: p.category,
        address: p.address, phone: p.phone, hasWebsite: !!p.website, website: p.website, sponsored: false }],
    };
  }
  let prev = -1;
  let stable = 0;
  for (let i = 0; i < 80 && res.cards.length < max && !res.end; i++) {
    await exec(pgScroll, '[role=feed]', 'a[href*="/maps/place/"]', 'href');
    await jitter(1200, 2200);
    await assertSafe();
    res = (await exec(pgCards)) || res;
    stable = res.cards.length === prev ? stable + 1 : 0;
    if (stable >= 3) break;
    prev = res.cards.length;
  }
  const cards = res.cards.slice(0, max);
  // Maps rewrites /maps/search/<q> to /maps/search/<q>/@lat,lng,zoomz/data=... a moment after the results show up (the server
  // falls back to the cards' bounding box if it never does).
  let vp = null;
  for (const end = Date.now() + 6000; !vp; await sleep(500)) {
    vp = (await currentUrl()).match(/\/@(-?\d+\.\d+),(-?\d+\.\d+),(\d+(?:\.\d+)?)z/);
    if (vp || Date.now() > end) break;
  }
  return { query, count: cards.length, reachedEnd: res.end, viewport: vp ? { lat: +vp[1], lng: +vp[2], zoom: +vp[3] } : null, cards };
}

const tryit = (p) => Promise.resolve(p).catch(() => null);
const MORE_TOPICS = 'button[aria-label^="View" i][aria-label*="more topic" i]';
const PHOTO_OPENERS = [
  'button[role=tab][aria-label*="photo" i]', 'button[aria-label^="Photo of" i]', 'button[jsaction*="heroHeaderImage"]',
  'button[aria-label*="photos" i]', 'a[aria-label*="photos" i]',
];

const SORT_BTN = ['button[aria-label*="Sort" i]', 'button[data-value="Sort"]'];

async function getPlace({ url, activity = true }) {
  await openMaps(url);
  const ready = await until(pgPlaceReady, [], (v) => v === 'full', 20000);
  if (!ready) throw new Error('Place panel did not load (not a place URL?)');
  const place = await exec(pgPlace);
  place.placeUrl = await currentUrl();
  // executeScript results come back with keys sorted alphabetically, so the Monday..Sunday order is restored here.
  const day = (d) => ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].findIndex((p) => d.toLowerCase().startsWith(p));
  place.hours = Object.fromEntries(Object.entries(place.hours || {}).sort(([a], [b]) => day(a) - day(b)));
  // Best effort from here on (each step may find nothing, none may throw): tabs change the panel, so About and photos go last.
  const x = {};
  for (let i = 0; i < 3; i++) { // lazy sections (photo categories, popular times, ...) render only after scrolling
    await scrollPanel();
    await jitter(500, 800);
  }
  const merge = (b) => { for (const [k, v] of Object.entries(b || {})) if (Array.isArray(v) ? v.length > (x[k]?.length || 0) : v && !x[k]) x[k] = v; };
  if (await tryit(click({ selectors: [MORE_TOPICS] }))) await sleep(400);
  merge(await tryit(exec(pgExtras)));
  place.photoCategories = (await tryit(exec(pgPhotoCategories))) || [];
  if (await tryit(click({ selectors: ['button[role=tab][aria-label^="Reviews" i]'] }))) { // summary: more topics, rating distribution
    await sleep(900);
    if (await tryit(click({ selectors: [MORE_TOPICS] }))) await sleep(400);
    merge(await tryit(exec(pgExtras)));
    if (activity && await tryit(click({ selectors: SORT_BTN }))) { // activity: sort by Newest, sample the first reviews
      await sleep(700);
      if (await tryit(click({ text: 'Newest' }))) {
        await sleep(1800);
        await until(() => document.querySelectorAll('[data-review-id]').length, [], (v) => v > 0, 6000);
        const sample = await tryit(exec(pgActivity));
        if (sample?.length) place.activitySample = sample; // the server turns it into place.activity
      }
    }
  }
  place.services = [];
  if (await tryit(click({ selectors: ['button[role=tab][aria-label^="Services" i]', 'button[role=tab][aria-label^="Menu" i]', 'button[role=tab][aria-label^="Products" i]'] }))) {
    await sleep(900);
    place.services = (await tryit(exec(pgServices))) || [];
  }
  place.reviewTopics = x.reviewTopics || [];
  place.ratingDistribution = x.ratingDistribution || [];
  place.priceRange = x.priceRange || null;
  place.fromBusiness = x.fromBusiness || null;
  place.locatedIn = x.locatedIn || null;
  place.popularTimes = x.popularTimes || [];
  if (x.servicesLink) place.links = { ...place.links, services: x.servicesLink };
  if (await tryit(click({ selectors: ['button[role=tab][aria-label^="About" i]'] }))) {
    await sleep(900);
    const about = await tryit(exec(pgAbout));
    if (about && Object.keys(about).length) place.about = about;
  }
  return place;
}

const SORT = { newest: 'Newest', highest: 'Highest rating', lowest: 'Lowest rating' };

async function getReviews({ url, limit = 20, sort = 'relevant' }) {
  await openMaps(url);
  if (!(await until(pgPlaceReady, [], (v) => v === 'full', 20000))) throw new Error('Place panel did not load');
  if (!(await click({ selectors: ['button[role=tab][aria-label^="Reviews" i]', 'button[aria-label^="Reviews" i]'] }))) {
    return { url: await currentUrl(), count: 0, reviews: [], note: 'no Reviews tab' };
  }
  await until(() => document.querySelectorAll('[data-review-id]').length, [], (v) => v > 0, 12000);
  if (SORT[sort] && await click({ selectors: SORT_BTN })) {
    await sleep(700);
    if (await click({ text: SORT[sort] })) await sleep(1800);
  }
  let prev = -1;
  let stable = 0;
  for (let i = 0; i < 60; i++) {
    const r = await exec(pgScroll, null, '[data-review-id]', 'data-review-id');
    if (r.count >= limit) break;
    stable = r.count === prev ? stable + 1 : 0;
    if (stable >= 3) break;
    prev = r.count;
    await jitter(1000, 1800);
    await assertSafe();
  }
  await exec(pgExpand);
  await sleep(300);
  await exec(pgExpand); // second pass: buttons that appear after the first expand
  await sleep(300);
  const reviews = (await exec(pgReviews)).slice(0, limit);
  return { url: await currentUrl(), count: reviews.length, sort, reviews };
}

// Size suffix "=w426-h240-k-no" / "=s40-c" -> "=s2048"; no suffix -> append.
const fullSize = (u) => (/=[wsh]\d+[^=?&\s]*$/.test(u) ? u.replace(/=[wsh]\d+[^=?&\s]*$/, '=s2048') : /googleusercontent/.test(u) ? `${u}=s2048` : u);

async function getPhotos({ url, limit = 30, streetview = false, category }) {
  await openMaps(url);
  if (!(await until(pgPlaceReady, [], (v) => v === 'full', 20000))) throw new Error('Place panel did not load');
  const opened = await click({ selectors: PHOTO_OPENERS });
  await sleep(1000);
  const categories = opened ? (await tryit(exec(pgPhotoCategories))) || [] : [];
  const grid = !!category; // a category view: read only the grid, not the overview thumbnails
  if (category) {
    if (!opened || !(await tryit(click({ text: category })))) return { url: await currentUrl(), category, count: 0, photos: [], categories, note: 'category not found' };
    await sleep(1500);
  }
  await until(pgPhotos, [streetview, grid], (v) => v?.length > 0, 10000);
  if (opened) {
    let prev = -1;
    let stable = 0;
    for (let i = 0; i < 60; i++) {
      const n = (await exec(pgPhotos, streetview, grid)).length;
      if (n >= limit) break;
      stable = n === prev ? stable + 1 : 0;
      if (stable >= 3) break;
      prev = n;
      await exec(pgScroll, null, 'a[data-photo-index]', null);
      await jitter(900, 1600);
      await assertSafe();
    }
  }
  const byBase = new Map(); // dedupe by URL without the size suffix
  for (const raw of await exec(pgPhotos, streetview, grid)) byBase.set(raw.replace(/^https:\/\/lh\d+\.googleusercontent\.com/, '').replace(/=[wsh]\d+[^=?&\s]*$/, ''), fullSize(raw));
  const photos = [...byBase.values()].slice(0, limit);
  return { url: await currentUrl(), ...(category && { category }), categories, count: photos.length, photos, ...(opened ? {} : { note: 'no photos button found' }) };
}

// Panel scroll (same helper getPlace uses for its lazy sections): bottom of the place panel's scroll container.
const scrollPanel = () => tryit(exec(pgScroll, null, '[data-item-id]', null));

// Competitor items have no href: read all of them first, then open each one to learn its URL and get back to the origin.
async function getCompetitors({ url, limit = 10 }) {
  await openMaps(url);
  if (!(await until(pgPlaceReady, [], (v) => v === 'full', 20000))) throw new Error('Place panel did not load');
  const name = await tryit(exec(() => [...document.querySelectorAll('h1')].map((h) => h.innerText.trim()).find((t) => t && !/^results$/i.test(t)) || null));
  const placeUrl = await currentUrl();
  const slugOf = (u) => { try { return decodeURIComponent(new URL(u).pathname.split('/')[3] || ''); } catch { return ''; } };
  // The section is lazy and far down the panel: scroll until the h2 shows up.
  const reveal = async () => {
    let items = await tryit(exec(pgCompetitorItems));
    for (let i = 0; i < 5 && !items?.length; i++) {
      await scrollPanel();
      await jitter(600, 1000);
      items = await tryit(exec(pgCompetitorItems));
    }
    return items;
  };
  // history.back() first; if the list is not back within ~6 s, reopen the origin place (a normal polite navigation).
  const toOrigin = async () => {
    await tryit(exec(() => history.back()));
    for (const end = Date.now() + 6000; Date.now() < end; await sleep(500)) {
      if (slugOf(await currentUrl()) === slugOf(placeUrl) && (await tryit(exec(pgCompetitorItems)))?.length) return true;
      await scrollPanel();
    }
    await openMaps(placeUrl);
    return !!(await until(pgPlaceReady, [], (v) => v === 'full', 20000)) && !!(await reveal())?.length;
  };
  const items = ((await reveal()) || []).filter((it) => it.name).slice(0, limit);
  const competitors = [];
  for (const [i, { index, ...card }] of items.entries()) {
    const entry = { ...card, placeUrl: null };
    competitors.push(entry);
    if (!(await tryit(exec(pgCompetitorClick, card.name)))) continue;
    for (const end = Date.now() + 8000; Date.now() < end; await sleep(300)) { // wait for the other place's panel
      const cur = await currentUrl();
      if (/\/maps\/place\//.test(cur) && slugOf(cur) !== slugOf(placeUrl)) { entry.placeUrl = cur; break; }
    }
    await assertSafe();
    if (!entry.placeUrl || i === items.length - 1) continue;
    if (!(await toOrigin())) break; // not even a fresh load shows the list: stop with what we have
    await jitter(1000, 1500);
  }
  return { name, placeUrl, count: competitors.length, competitors };
}

// Click the middle of the map canvas (synthetic events): at high zoom this selects the place exactly at the URL's center.
function pgClickCanvasCenter() {
  const c = document.querySelector('canvas');
  if (!c) return false;
  const r = c.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const el = document.elementFromPoint(x, y) || c;
  const fire = (type, init) => {
    const pointer = type.startsWith('pointer');
    const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons: type.endsWith('down') ? 1 : 0, ...init };
    if (pointer) Object.assign(base, { pointerId: 1, pointerType: 'mouse', isPrimary: true });
    try { el.dispatchEvent(new (pointer ? PointerEvent : MouseEvent)(type, { ...base, view: window })); } catch { el.dispatchEvent(new (pointer ? PointerEvent : MouseEvent)(type, base)); }
  };
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) fire(t, {});
  return true;
}

// Which place is exactly at lat,lng? Open the map there at zoom 20 and click the canvas center. Returns { placeUrl, name }, or null
// when the click selected no place (a dropped pin has a /maps/place/ URL too, but no place id).
async function clickPoi({ lat, lng }) {
  if (!Number.isFinite(+lat) || !Number.isFinite(+lng)) throw new Error('Bad coordinates');
  await openMaps(`https://www.google.com/maps/@${+lat},${+lng},20z?hl=en`);
  await until(() => !!document.querySelector('canvas'), [], (v) => v, 10000);
  await jitter(3000, 4000); // tiles and POI labels
  if (!(await tryit(exec(pgClickCanvasCenter)))) return null;
  const hasFid = (u) => /\/maps\/place\//.test(u) && /!1s0x[0-9a-f]+:0x[0-9a-f]+/i.test(decodeURIComponent(u));
  for (const end = Date.now() + 5000; Date.now() < end; await sleep(400)) {
    const cur = await currentUrl();
    if (hasFid(cur)) {
      await sleep(600); // let the h1 render
      const name = await tryit(exec(() => [...document.querySelectorAll('h1')].map((h) => h.innerText.trim()).find((t) => t && !/^results$/i.test(t)) || null));
      return { placeUrl: await currentUrl(), name };
    }
  }
  await assertSafe();
  return null;
}

// Maps shows a bare coordinate as a panel with the DMS title, decimal coordinates and a plus code (no address): return its text.
async function getPoint({ lat, lng }) {
  if (!Number.isFinite(+lat) || !Number.isFinite(+lng)) throw new Error('Bad coordinates');
  await openMaps(`https://www.google.com/maps/search/${+lat},${+lng}?hl=en`);
  await until(pgPlaceReady, [], (v) => v, 15000); // the h1 is the DMS title
  await jitter(400, 800);
  return { url: await currentUrl(), lines: await exec(pgText, 60) };
}

// ---------- Low-level fallback (acts on the current Maps tab, never navigates) ----------

async function readPage({ maxLines = 200 }) {
  const lines = await exec(pgText, maxLines);
  return { url: await currentUrl(), lines };
}

async function clickTool({ index, selector, text }) {
  const label = await click({ selectors: selector ? [selector] : [], text, index });
  if (label === null) throw new Error('Element not found');
  await sleep(800);
  await assertSafe();
  return { clicked: label };
}

async function scrollTool({ selector, times = 3 }) {
  let last = null;
  for (let i = 0; i < times; i++) {
    last = await exec(pgScroll, selector || '[role=feed]', null, null); // falls back to the page when absent
    await jitter(900, 1600);
  }
  await assertSafe();
  return last;
}

// ---------- Handlers ----------

// One browser job at a time; a halt blocks all work until Resume.
let chain = Promise.resolve();
const job = (fn) => (args) => {
  const p = chain.then(async () => {
    const { halted } = await chrome.storage.local.get('halted');
    if (halted) throw new Error(`HALT: ${halted.reason}. Press Resume in the extension popup.`);
    return fn(args);
  });
  chain = p.catch(() => {});
  return p;
};

const handlers = {
  search: job(search),
  getPlace: job(getPlace),
  getReviews: job(getReviews),
  getPhotos: job(getPhotos),
  getCompetitors: job(getCompetitors),
  getPoint: job(getPoint),
  clickPoi: job(clickPoi),
  readPage: job(readPage),
  snapshot: job(async () => exec(pgSnapshot, INTERACTIVE)),
  click: job(clickTool),
  scroll: job(scrollTool),
};

// ---------- Boot ----------

chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onMessage.addListener((msg) => { if (msg === 'reconnect') connect(); });
setConnected(false);
connect();
