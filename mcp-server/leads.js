// Pure helpers (plus a tiny jsonl store): website classifier, lead upsert, CSV, URL/path validation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const STATUSES = ['new', 'contacted', 'replied', 'won', 'rejected', 'skip'];

// Hosts that are not a real website: social profiles, link-in-bio pages, Google's profile page.
const SOCIAL = ['facebook.com', 'fb.com', 'fb.me', 'instagram.com', 'linktr.ee', 'tiktok.com', 'wa.me', 'whatsapp.com',
  't.me', 'linkin.bio', 'bio.link', 'beacons.ai', 'vk.com', 'x.com', 'twitter.com', 'g.page'];
// Site-builder / template subdomains and booking-only pages: a "website" that is a placeholder.
const WEAK_SITE = ['sites.helpercrm.com', 'wixsite.com', 'tilda.ws', 'taplink.cc', 'taplink.at', 'sites.google.com', 'business.site',
  'weebly.com', 'blogspot.com', 'carrd.co', 'notion.site', 'squarespace.com', 'jimdosite.com', 'jimdofree.com', 'webflow.io',
  'framer.website', 'godaddysites.com', 'wordpress.com', 'mystrikingly.com', 'square.site',
  'alteg.io', 'booksy.com', 'dikidi.net', 'easyweek.io'];
const WEAK_SITE_RE = [/(^|\.)(easyweek|booksy|dikidi)\.[a-z.]+$/, /(^|\.)webnode\.[a-z.]+$/, /(^|\.)ucoz\.[a-z.]+$/, /\.prom\.ua$/]; // *.prom.ua = company subpage, not the marketplace itself

export const hostOf = (u) => {
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
};
const inList = (h, list) => list.some((d) => h === d || h.endsWith(`.${d}`));
// URL shorteners: the real destination is only known after following the redirect.
const SHORTENERS = ['bit.ly', 'tinyurl.com', 'goo.gl', 't.co', 'cutt.ly', 'rb.gy', 'is.gd', 'ow.ly', 'buff.ly', 'shorturl.at', 'tiny.cc', 'lnkd.in', 'goo.su'];
export const isShortener = (u) => { const h = u ? hostOf(String(u).trim()) : null; return !!h && inList(h, SHORTENERS); };

// no_website | social_only | weak_website | has_website
export function classifyWebsite(url) {
  const h = url ? hostOf(String(url).trim()) : null;
  if (!h || !h.includes('.')) return 'no_website';
  if (inList(h, SOCIAL)) return 'social_only';
  return inList(h, WEAK_SITE) || WEAK_SITE_RE.some((re) => re.test(h)) ? 'weak_website' : 'has_website';
}

// Ukrainian national transliteration (KMU 2010): Maps addresses are English, areas are often typed in Ukrainian.
const UK = { а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i', к: 'k',
  л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia' };
const UK_INITIAL = { є: 'ye', ї: 'yi', й: 'y', ю: 'yu', я: 'ya' };
const normPlace = (s) => String(s || '').toLowerCase().replace(/['’ʼ`"“”«»]/g, '').replace(/[-–—]/g, ' ').replace(/\s+/g, ' ').trim();
export const translit = (s) => normPlace(s).split(' ').map((w) => [...w].map((c, i) => (i === 0 && UK_INITIAL[c]) || (UK[c] ?? c)).join('')).join(' ');

// Is the place's address inside the area? Area, its transliteration, or its first word must appear in the address.
// Empty address = cannot tell, so not rejected. ponytail: substring match ("Kyiv" also matches "Kyiv Oblast").
export function addressInArea(address, area) {
  const addr = normPlace(address);
  const a = normPlace(area);
  if (!addr || !a) return true;
  const first = a.split(' ')[0];
  return [a, translit(a), first, translit(first)].some((c) => c.length >= 3 && addr.includes(c));
}

// Maps place URL -> { lat, lng, fid, placeId }. placeId = ChIJ... when present, else the 0x..:0x.. feature id.
export function parsePlaceUrl(url = '') {
  let s = String(url);
  try { s = decodeURIComponent(s); } catch { /* keep raw */ }
  // A competitor opened from a place panel carries BOTH places in its data blob (origin first). Coordinates and ChIJ id
  // are taken only from after the LAST feature id; a competitor without them yet gets null, never the origin's (or the viewport's).
  const fids = [...s.matchAll(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/gi)];
  const lastFid = fids.at(-1);
  const tail = lastFid ? s.slice(lastFid.index + lastFid[0].length) : s;
  const lastIn = (str, re) => [...str.matchAll(re)].at(-1);
  const LL = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/g;
  const CHIJ = /!19s(ChIJ[\w-]+)/g;
  const single = fids.length <= 1; // one place in the URL: its data may also sit before the id, or in @lat,lng
  const ll = lastIn(tail, LL) || (single ? lastIn(s, LL) || s.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) : null);
  const fid = lastFid?.[1] || null;
  const chij = (lastIn(tail, CHIJ) || (single && lastIn(s, CHIJ)))?.[1] || null;
  return { lat: ll ? +ll[1] : null, lng: ll ? +ll[2] : null, fid, placeId: chij || fid };
}

export const isMapsUrl = (u) => {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && ((x.hostname === 'www.google.com' && /^\/maps(\/|$)/.test(x.pathname))
      || x.hostname === 'maps.app.goo.gl' || (x.hostname === 'goo.gl' && /^\/maps(\/|$)/.test(x.pathname)));
  } catch { return false; }
};

// Stable lead id: feature id first (present in nearly every place URL), then ChIJ id, then the URL path.
export const leadKey = (l) => {
  if (l.fid || l.placeId) return l.fid || l.placeId;
  try { return l.placeUrl ? new URL(l.placeUrl).pathname : null; } catch { return null; }
};

// Insert or merge. Keeps firstSeen/status/note of an existing lead; empty new values never overwrite old ones.
export function upsertLead(list, lead, now = new Date().toISOString()) {
  const id = leadKey(lead);
  if (!id) throw new Error('lead has no placeId or placeUrl');
  const i = list.findIndex((l) => l.id === id);
  const set = Object.fromEntries(Object.entries(lead).filter(([, v]) => v != null && v !== ''));
  const merged = i < 0
    ? { status: 'new', firstSeen: now, ...set, id, lastSeen: now }
    : { ...list[i], ...set, id, firstSeen: list[i].firstSeen, status: list[i].status, lastSeen: now };
  const next = list.slice();
  if (i < 0) next.push(merged); else next[i] = merged;
  return { list: next, lead: merged, isNew: i < 0 };
}

// "a week ago" / "2 months ago" / "Edited 5 months ago" / "a month ago on Google" -> approximate days; null if unparseable.
export function agoToDays(text) {
  const t = String(text || '').toLowerCase().replace(/^edited\s+/, '').trim();
  if (/^(just now|now)$/.test(t)) return 0;
  const m = t.match(/^(a|an|\d+)\s+(minute|hour|day|week|month|year)s?\s+ago(?:\s+on\s+.+)?$/);
  if (!m) return null;
  const n = m[1] === 'a' || m[1] === 'an' ? 1 : +m[1];
  return Math.round(n * { minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7, month: 30, year: 365 }[m[2]]);
}

// Cards of places you already visited carry a "· Visited link" marker (also as a line of its own): remove it; null if nothing is left.
export function stripVisited(v) {
  if (v == null) return null;
  const t = String(v).replace(/\s*[·⋅]\s*Visited link\s*$/i, '').trim();
  return !t || /^Visited link$/i.test(t) ? null : t;
}

export function haversineKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Map zoom at which a circle of radius km fits the viewport. ponytail: the shorter side of the ~1000x800 px map (800 px) must
// hold the diameter plus 10%; ground resolution is 40075 km * cos(lat) / (256 * 2^zoom) per pixel. Rounded down to 0.1, 3..19.
export function zoomForRadius(km, lat = 0) {
  const z = Math.log2((800 * 40075.016 * Math.cos((lat * Math.PI) / 180)) / (256 * 2.2 * km));
  return Math.max(3, Math.min(19, Math.floor(z * 10) / 10));
}

// {lat, lng} or "lat,lng" -> validated { lat, lng } (lat -90..90, lng -180..180); throws otherwise.
export function parseCenter(c) {
  let lat;
  let lng;
  if (typeof c === 'string') {
    const p = c.split(',');
    if (p.length === 2 && p.every((x) => x.trim())) [lat, lng] = p.map(Number);
  } else if (c && typeof c === 'object') [lat, lng] = [c.lat, c.lng].map((x) => (x === '' || x == null ? NaN : Number(x)));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new Error('Invalid coordinates (lat -90..90, lng -180..180): ' + JSON.stringify(c));
  }
  return { lat, lng };
}

// Text lines of the panel Maps shows for a bare coordinate ("R2PC+VJF Lviv, Lviv Oblast") -> plus code + locality.
export function plusCodeFromLines(lines) {
  for (const l of lines || []) {
    const m = String(l).trim().match(/^([23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3})\b\s*(.*)$/);
    if (m) return { plusCode: m[1], locality: m[2].trim() || null };
  }
  return { plusCode: null, locality: null };
}

// Google ad/redirect links (google.*/aclk?...&adurl=, /url?q=, /pagead/...) are not the business's site: return the target URL
// they carry, or null when it is empty/not http(s). Other URLs (also sites.google.com) pass through unchanged.
export function unwrapGoogleRedirect(url) {
  if (!url) return null;
  let u;
  try { u = new URL(url); } catch { return url; }
  if (!/(^|\.)google\.[a-z.]+$/i.test(u.hostname) || !/^\/(aclk|url|pagead\/)/.test(u.pathname)) return url;
  for (const k of ['adurl', 'url', 'q']) {
    const v = u.searchParams.get(k);
    if (v && /^https?:\/\//i.test(v)) return v;
  }
  return null;
}

// Viewport { lat, lng, zoom } that contains the cards' coordinates; null without any. Fallback for when Maps has not rewritten
// the search URL to .../@lat,lng,zoomz. ponytail: ~1000x800 px map, 20% margin, zoom 3..16 (same approximation as gridTiles).
export function viewportOfCards(cards) {
  const pts = (cards || []).map((c) => { const p = parsePlaceUrl(c.placeUrl); return [c.lat ?? p.lat, c.lng ?? p.lng]; }).filter(([a, b]) => a != null && b != null);
  if (!pts.length) return null;
  const la = pts.map((p) => p[0]);
  const ln = pts.map((p) => p[1]);
  const lat = (Math.min(...la) + Math.max(...la)) / 2;
  const lng = (Math.min(...ln) + Math.max(...ln)) / 2;
  const lngSpan = Math.max(Math.max(...ln) - Math.min(...ln), 1e-4) * 1.2;
  const latSpan = Math.max(Math.max(...la) - Math.min(...la), 1e-4) * 1.2;
  const z = Math.min(Math.log2((1000 * 360) / (256 * lngSpan)), Math.log2((800 * 360 * Math.cos((lat * Math.PI) / 180)) / (256 * latSpan)));
  return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, zoom: Math.round(Math.max(3, Math.min(16, z)) * 10) / 10 };
}

// Popular-times groups come only for days with data, in Sunday..Saturday order, without day labels. 7 groups = all days;
// fewer: the open days from hours (not "Closed") in the same order, if their number matches. The group that is visible today
// must map to today's weekday, else nothing is assigned (wrong guess is worse than null; uses the machine's clock/timezone).
export function mapPopularTimes(groups, hours, now = new Date()) {
  const list = Array.isArray(groups) ? groups : [];
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  if (!list.length || list.every((g) => g.day)) return list;
  const open = DAYS.filter((d) => {
    const k = Object.keys(hours || {}).find((h) => h.toLowerCase().startsWith(d.slice(0, 3).toLowerCase()));
    return k && !/^closed$/i.test(String(hours[k]).trim());
  });
  if (open.length !== list.length) return list;
  const mapped = list.map((g, i) => ({ ...g, day: open[i] }));
  return mapped.some((g) => g.today && g.day !== DAYS[now.getDay()]) ? list : mapped;
}

// Newest-first sample of reviews [{ date, replied }] -> activity signals; null without a sample.
export function summarizeActivity(sample) {
  const rows = (Array.isArray(sample) ? sample : []).map((r) => ({ date: r?.date ?? null, days: agoToDays(r?.date), replied: !!r?.replied }));
  if (!rows.length) return null;
  const dated = rows.filter((r) => r.days != null);
  const newest = dated.reduce((a, b) => (b.days < a.days ? b : a), dated[0]);
  return {
    lastReviewAgo: newest ? newest.date.replace(/^Edited\s+/i, '') : null,
    lastReviewDays: newest ? newest.days : null,
    recentReviews90d: dated.filter((r) => r.days <= 90).length,
    ownerReplyRate: Math.round((rows.filter((r) => r.replied).length / rows.length) * 100) / 100,
    sampled: rows.length,
  };
}

// Centers of an n x n grid of tiles covering a Maps viewport { lat, lng, zoom }; each tile is searched at zoom + log2(n).
// ponytail: assumes a ~1000x800 px map (the results panel hides part of it) and Mercator scale (degrees per pixel =
// 360 / (256 * 2^zoom), latitude scaled by cos(lat)); tiles may overlap or leave small gaps, dedupe absorbs overlap.
export function gridTiles({ lat, lng, zoom }, n, w = 1000, h = 800) {
  const deg = 360 / (256 * 2 ** zoom);
  const lngSpan = w * deg;
  const latSpan = h * deg * Math.cos((lat * Math.PI) / 180);
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  const z = Math.round((zoom + Math.log2(n)) * 100) / 100;
  const out = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) out.push({ lat: r6(lat + (0.5 - (i + 0.5) / n) * latSpan), lng: r6(lng + ((j + 0.5) / n - 0.5) * lngSpan), zoom: z });
  }
  return out;
}

// Deterministic prospect ranking (the base model cannot rank leads reliably). Max 100: website 40 + reviews 30 + rating 15 +
// unclaimed 10 + phone 5, +5 recent reviews, -15 none for a year, +5 owner replies; clamped to 0..100. Closed places score 0.
export function leadScore(l) {
  if (l.closed) return { score: 0, reasons: ['closed'] };
  const reasons = [];
  let score = 0;
  const add = (pts, why) => { score += pts; if (why && pts > 0) reasons.push(why); };
  const site = { no_website: [40, 'no website'], weak_website: [32, 'only a template/booking page'], social_only: [30, 'only a social page'] }[l.classification];
  if (site) add(...site);
  const n = l.reviewsCount || 0;
  if (n >= 200) add(30, 'well-known (200+ reviews)');
  else if (n >= 50) add(25, 'established (many reviews)');
  else if (n >= 10) add(15, 'modest number of reviews');
  else if (n >= 1) add(5, 'very few reviews');
  const r = l.rating;
  if (r == null) add(3);
  else if (r >= 4.7) add(15, 'excellent rating');
  else if (r >= 4.3) add(12, 'very good rating');
  else if (r >= 3.8) add(6, 'mixed rating');
  if (l.claimed === false) add(10, 'listing unclaimed');
  if (l.phone) add(5, 'has phone');
  const a = l.activity;
  if (a?.lastReviewDays != null) {
    if (a.lastReviewDays <= 90) add(5, 'active (recent reviews)');
    else if (a.lastReviewDays > 365) { score -= 15; reasons.push('inactive (no reviews in a year)'); }
  }
  if (a && a.sampled >= 3 && a.ownerReplyRate >= 0.5) add(5, 'owner replies to reviews');
  return { score: Math.max(0, Math.min(100, score)), reasons };
}
export const scoreOf = (l) => { const { score, reasons } = leadScore(l); return { leadScore: score, leadReasons: reasons }; };
export const withScore = (l) => ({ ...l, ...scoreOf(l) });
// Best prospects first; ties by number of reviews.
export const byScore = (a, b) => (b.leadScore - a.leadScore) || ((b.reviewsCount ?? -1) - (a.reviewsCount ?? -1));
export const ranked = (list) => list.map(withScore).sort(byScore);

export function updateLead(list, { id, newStatus, note }, now = new Date().toISOString()) {
  const i = list.findIndex((l) => l.id === id);
  if (i < 0) throw new Error(`No lead ${id}`);
  if (newStatus && !STATUSES.includes(newStatus)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
  const lead = { ...list[i], ...(newStatus && { status: newStatus }), ...(note != null && { note }), updatedAt: now };
  const next = list.slice();
  next[i] = lead;
  return { list: next, lead };
}

export function loadLeads(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e; // corrupt file: fail loudly rather than overwrite the tracker
  }
}

export function saveLeads(file, list) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, list.map((l) => JSON.stringify(l) + '\n').join(''));
  fs.renameSync(tmp, file);
}

// CSV cell: quote when needed, and neutralise spreadsheet formulas (=, @, or +/- that is not a plain number/phone).
export const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=@\t\r]/.test(s) || (/^[+-]/.test(s) && !/^[+-]?[\d\s().-]+$/.test(s))) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (rows, cols) => [cols, ...rows.map((r) => cols.map((c) => r[c]))].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';

// Fields of an HTML page that matter for "is this site dead/outdated": no scripts are run.
export function analyzeHtml(html) {
  const years = [...html.matchAll(/(?:©|&copy;|&#169;|copyright)\s*(?:(?:19|20)\d{2}\s*[-–—]\s*)?((?:19|20)\d{2})/gi)].map((m) => +m[1]);
  return {
    title: html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1].replace(/\s+/g, ' ').trim() || null,
    mobileFriendly: /<meta[^>]+name=["']viewport["']/i.test(html),
    copyrightYear: years.length ? Math.max(...years) : null,
    generator: html.match(/<meta[^>]+name=["']generator["'][^>]*content=["']([^"']+)/i)?.[1] || null,
  };
}

// SSRF guard for server-side fetches. ponytail: hostname check only (no DNS resolution); all IPv6 literals refused.
export const isPrivateHost = (h) => /^(localhost|.*\.(local|internal|localdomain))$/i.test(h)
  || /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.startsWith('[');

export function imageExt(b) {
  if (b.length < 12) return null;
  const h = b.toString('hex', 0, 4);
  if (h.startsWith('ffd8ff')) return 'jpg';
  if (h === '89504e47') return 'png';
  if (h === '47494638') return 'gif';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (b.toString('latin1', 4, 8) === 'ftyp' && /avif|avis/.test(b.toString('latin1', 8, 12))) return 'avif';
  return null;
}

// Photo URL without host and size suffix: the same picture at different sizes/hosts has the same base.
export const photoBase = (u) => String(u).replace(/^https:\/\/lh\d+\.googleusercontent\.com/, '').replace(/=[wsh]\d+[^=?&\s]*$/, '');

// "By owner" photos first, then the rest; each picture once. -> [{ url, byOwner }]
export function mergePhotos(owner = [], all = []) {
  const seen = new Set();
  const out = [];
  for (const [list, byOwner] of [[owner, true], [all, false]]) {
    for (const url of list) {
      const k = photoBase(url);
      if (!seen.has(k)) { seen.add(k); out.push({ url, byOwner }); }
    }
  }
  return out;
}

export const slug = (s) => String(s || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-')
  .replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'place';

// Resolve a user-supplied path (~ allowed); it must stay inside $HOME.
export function underHome(p, home = os.homedir()) {
  const abs = path.resolve(home, String(p).replace(/^~(?=\/|$)/, home));
  const rel = path.relative(home, abs);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`Path must be inside ${home}: ${p}`);
  return abs;
}

// ---------- JSONL rows for laya-cli ({ id, kind, state, ...flat fields }) ----------

const FLAT = ['name', 'category', 'rating', 'reviewsCount', 'address', 'phone', 'website', 'websiteResolved', 'classification',
  'claimed', 'status', 'placeUrl', 'lat', 'lng', 'area', 'query', 'priceRange', 'priceLevel', 'closed', 'locatedIn', 'reviewTopics', 'photoCategories', 'leadScore', 'leadReasons', 'distanceKm'];
const FLAT_REVIEW = ['author', 'rating', 'date', 'text', 'ownerReply', 'placeUrl', 'placeName'];
const clip = (s) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > 1500 ? `${t.slice(0, 1499)}…` : t; };

// Scalars stay; arrays become "a (6); b (3)" / "a; b"; objects are dropped.
const flatVal = (v) => {
  if (v == null || v === '') return undefined;
  if (['string', 'number', 'boolean'].includes(typeof v)) return v;
  if (Array.isArray(v)) {
    const s = v.map((x) => (x && typeof x === 'object' ? (x.topic != null ? `${x.topic} (${x.count})` : null) : x)).filter((x) => x != null && x !== '').join('; ');
    return s || undefined;
  }
  return undefined;
};

// City part of a Maps address ("Kil'tseva St, 1a, Vynnyky, Lviv Oblast, 79495" -> "Vynnyky"); null when only a street is there.
export function localityOf(address) {
  const parts = String(address || '').split(',').map((x) => x.trim()).filter(Boolean);
  const i = parts.findIndex((x) => /\b(Oblast|Region|Krai|Province|County|State)\b/i.test(x));
  const ok = (x) => x && !/\d/.test(x) && !/\b(St|Street|Ave|Avenue|Rd|Road|Blvd|Ln|Lane|Sq|Square|vul|вул|вулиця|проспект)\b\.?/i.test(x);
  if (i > 0) return ok(parts[i - 1]) ? parts[i - 1] : null;
  const rest = parts.filter((x) => !/^\d{4,}$/.test(x) && !/^Ukraine$/i.test(x));
  return rest.length > 1 && ok(rest.at(-1)) ? rest.at(-1) : null;
}

// The model cannot compare raw numbers, so judgements are computed here and sent as words; the numbers stay in the flat
// fields. Only fields present in the source produce a sentence (null reviewsCount = Maps shows none; undefined = unknown).
const WEBSITE_WORDS = {
  no_website: 'It has no website at all.',
  social_only: 'It uses only a social media page instead of a website.',
  weak_website: 'It has only a template or booking page, not a real website.',
  has_website: 'It already has its own website.',
};
export const reviewsWords = (n) => (!n ? 'It has no reviews yet.'
  : n < 10 ? 'It has very few reviews, so it is likely new or very small.'
  : n < 50 ? 'It has a modest number of reviews.'
  : n < 200 ? 'It is an established business with many reviews.'
  : 'It is a well-known, very popular local business.');
export const ratingWords = (r) => (r >= 4.7 ? 'Customers rate it excellent.'
  : r >= 4.3 ? 'Customers rate it very good.'
  : r >= 3.8 ? 'Customer ratings are mixed but mostly positive.'
  : 'Customer ratings are weak.');

function placeState(o) {
  const city = localityOf(o.address);
  const p = [[o.name || 'Unnamed place', o.category, city].filter(Boolean).join(' — ') + '.'];
  if (o.reviewsCount !== undefined) p.push(reviewsWords(o.reviewsCount));
  if (o.rating != null) p.push(ratingWords(o.rating));
  if (WEBSITE_WORDS[o.classification]) p.push(WEBSITE_WORDS[o.classification]);
  if (o.claimed === false) p.push('The owner has not claimed the Google listing.');
  if (o.distanceKm != null) p.push(o.distanceKm < 1 ? 'It is very close (under 1 km).' : o.distanceKm <= 5 ? 'It is nearby (1-5 km).' : 'It is farther away (over 5 km).');
  if (o.closed) p.push(o.closed === 'permanent' ? 'It is permanently closed.' : 'It is temporarily closed.');
  const topics = (Array.isArray(o.reviewTopics) ? o.reviewTopics.slice(0, 8).map((x) => x?.topic ?? x) : String(o.reviewTopics || '').replace(/\s*\(\d+\)/g, '').split('; '))
    .filter(Boolean).join(', ');
  if (topics) p.push('Reviewers mention: ' + topics + '.');
  if (o.phone) p.push('It lists a phone number.');
  const a = o.activity;
  if (a?.lastReviewDays != null) { if (a.lastReviewDays <= 90) p.push('It has recent reviews.'); else if (a.lastReviewDays > 365) p.push('It has had no reviews for over a year.'); }
  if (a && a.sampled >= 3 && a.ownerReplyRate >= 0.5) p.push('The owner replies to reviews.');
  return clip(p.join(' '));
}

const reviewState = (o) => clip(`${o.rating != null ? `${o.rating}/5 ` : ''}review${o.date ? ` (${o.date})` : ''}${o.text ? `: ${o.text}` : ''}${o.ownerReply ? `. Owner replied: ${o.ownerReply}` : ''}`);

// kind: place | lead | card | competitor | review. Reviews need `index` (and the place's fid/placeId) for their id.
export function toJsonlRow(kind, o) {
  const review = kind === 'review';
  const base = review ? (o.fid || o.placeId || o.placeUrl || '') : (o.id ?? o.fid ?? o.placeId ?? o.placeUrl ?? null);
  const row = { id: review ? `${base}:${o.index ?? 0}` : base, kind, state: review ? reviewState(o) : placeState(o) };
  for (const k of review ? FLAT_REVIEW : FLAT) { const v = flatVal(o[k]); if (v !== undefined) row[k] = v; }
  if (!review && o.activity) { // scalars only: the nested object stays out
    if (o.activity.lastReviewDays != null) row.lastReviewDays = o.activity.lastReviewDays;
    if (o.activity.ownerReplyRate != null) row.ownerReplyRate = o.activity.ownerReplyRate;
  }
  return row;
}

// Target file: explicit path (inside $HOME) or ~/gmaps-leads/jsonl/<kind>s-<timestamp>.jsonl.
// MCP clients with a stale schema send booleans as strings: "true"/"1"/"yes" = on, "false"/"0"/"no"/"" = off, anything else
// must be a path ending in .jsonl. Returns false | true | path.
export function jsonlOpt(v) {
  if (v == null || typeof v === 'boolean') return !!v;
  const t = String(v).trim();
  if (/^(true|1|yes)$/i.test(t)) return true;
  if (/^(false|0|no|)$/i.test(t)) return false;
  if (!/\.jsonl$/i.test(t)) throw new Error(`jsonl must be true or a path ending in .jsonl: ${t}`);
  return t;
}

export function jsonlTarget(kind, p, now = new Date(), home = os.homedir()) {
  const o = jsonlOpt(p);
  if (typeof o === 'string') return underHome(o, home);
  return path.join(home, 'gmaps-cli-leads', 'jsonl', `${kind}s-${now.toISOString().slice(0, 19).replace(/:/g, '-')}.jsonl`);
}

export function writeJsonl(file, rows, append = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  (append ? fs.appendFileSync : fs.writeFileSync)(file, rows.map((r) => JSON.stringify(r) + '\n').join(''));
  return file;
}
