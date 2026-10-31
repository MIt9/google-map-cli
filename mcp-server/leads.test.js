import assert from 'node:assert';
import test from 'node:test';
import { stripVisited, haversineKm, parseCenter, plusCodeFromLines, zoomForRadius, mapPopularTimes, unwrapGoogleRedirect, viewportOfCards, agoToDays, byScore, gridTiles, summarizeActivity, leadScore, localityOf, jsonlOpt, jsonlTarget, toJsonlRow, mergePhotos, addressInArea, analyzeHtml, classifyWebsite, imageExt, isMapsUrl, isShortener, parsePlaceUrl, toCsv, underHome, updateLead, upsertLead } from './leads.js';

test('classifyWebsite', () => {
  for (const [u, want] of [
    [null, 'no_website'], ['', 'no_website'], ['https://www.facebook.com/shop', 'social_only'],
    ['instagram.com/shop', 'social_only'], ['https://linktr.ee/x', 'social_only'], ['https://shop.business.site/', 'weak_website'],
    ['https://sites.google.com/view/x', 'weak_website'], ['https://wa.me/380', 'social_only'], ['https://g.page/x', 'social_only'],
    ['https://a.wixsite.com/b', 'weak_website'], ['https://x.tilda.ws', 'weak_website'], ['taplink.cc/x', 'weak_website'],
    ['https://sites.helpercrm.com/x', 'weak_website'], ['https://shop.prom.ua', 'weak_website'], ['https://prom.ua', 'has_website'],
    ['https://a.webnode.com.ua', 'weak_website'], ['https://x.ucoz.ua', 'weak_website'], ['https://n123.alteg.io/x', 'weak_website'],
    ['https://booksy.com/en/x', 'weak_website'], ['https://dikidi.net/1', 'weak_website'], ['https://wixsite.com.evil.com', 'has_website'],
    ['https://example.com', 'has_website'], ['https://max.com', 'has_website'], ['cafe.ua/menu', 'has_website'],
  ]) assert.equal(classifyWebsite(u), want, String(u));
});

test('upsertLead keeps firstSeen/status/note, ignores empty values', () => {
  const a = upsertLead([], { fid: '0x1:0x2', name: 'Cafe', phone: '123', claimed: false }, 't1');
  assert.ok(a.isNew);
  assert.equal(a.lead.status, 'new');
  const b = updateLead(a.list, { id: a.lead.id, newStatus: 'contacted', note: 'called' }, 't2');
  const c = upsertLead(b.list, { fid: '0x1:0x2', name: 'Cafe 2', phone: '', claimed: false, status: 'new' }, 't3');
  assert.ok(!c.isNew);
  assert.equal(c.list.length, 1);
  assert.deepEqual([c.lead.firstSeen, c.lead.lastSeen, c.lead.status, c.lead.note, c.lead.phone, c.lead.name], ['t1', 't3', 'contacted', 'called', '123', 'Cafe 2']);
  assert.throws(() => updateLead(b.list, { id: 'nope' }));
  assert.throws(() => updateLead(b.list, { id: a.lead.id, newStatus: 'bogus' }));
});

test('toCsv escapes quotes, commas, newlines and formulas', () => {
  const csv = toCsv([{ a: 'x,"y"', b: 'l1\nl2', c: '=SUM(A1)', d: '+380 44 123', e: null }], ['a', 'b', 'c', 'd', 'e']);
  assert.equal(csv, 'a,b,c,d,e\n"x,""y""","l1\nl2",\'=SUM(A1),+380 44 123,\n');
});

test('url, path and html helpers', () => {
  const u = 'https://www.google.com/maps/place/X/data=!4m6!3m5!1s0x47a:0xabc!8m2!3d50.45!4d30.52!16s%2Fg%2F1!19sChIJabc_-1?hl=en';
  assert.deepEqual(parsePlaceUrl(u), { lat: 50.45, lng: 30.52, fid: '0x47a:0xabc', placeId: 'ChIJabc_-1' });
  assert.ok(isShortener('https://bit.ly/4qe6nyU') && !isShortener('https://linktr.ee/x') && !isShortener('https://bit.ly.evil.com'));
  const both = 'https://www.google.com/maps/place/Фрезура+Barbershop+2/@49.84,23.99,17z/data=!3m1!4b1!4m14!1m7!3m6!1s0x473add706d12064b:0xb2a67bac0701809f!2sFrisor+Lemberg+Barbershop!8m2!3d49.8372!4d24.021561!16s%2Fg%2F1!3m5!1s0x473addc8da0d8141:0xf3f63acce1c45bdf!8m2!3d49.8466647!4d23.9958688!16s%2Fg%2F2';
  assert.deepEqual(parsePlaceUrl(both), { lat: 49.8466647, lng: 23.9958688, fid: '0x473addc8da0d8141:0xf3f63acce1c45bdf', placeId: '0x473addc8da0d8141:0xf3f63acce1c45bdf' }); // the competitor, not the origin
  assert.ok(isMapsUrl('https://maps.app.goo.gl/abc') && isMapsUrl(u));
  assert.ok(!isMapsUrl('https://www.google.com/search?q=x') && !isMapsUrl('http://www.google.com/maps') && !isMapsUrl('https://evil.com/maps'));
  assert.throws(() => underHome('/etc', '/home/u'));
  assert.throws(() => underHome('~/../x', '/home/u'));
  assert.equal(underHome('~/leads', '/home/u'), '/home/u/leads');
  assert.deepEqual(analyzeHtml('<title> A\nB </title><meta name="viewport" content="x">&copy; 2012-2016'),
    { title: 'A B', mobileFriendly: true, copyrightYear: 2016, generator: null });
  assert.equal(imageExt(Buffer.from('ffd8ffe000104a4649460001', 'hex')), 'jpg');
  assert.equal(imageExt(Buffer.from('<html>not an image</html>')), null);
});

test('addressInArea matches the area or its Ukrainian transliteration', () => {
  assert.ok(addressInArea('Vynna Hora St, 8, Vynnyky, Lviv Oblast', 'Винники'));
  assert.ok(!addressInArea('Akademika Jangelia St, 46, Vinnytsia, Vinnytsia Oblast', 'Винники'));
  assert.ok(addressInArea('Shevchenka Ave, 1, Lviv, Lviv Oblast', 'Львів'));
  assert.ok(addressInArea('Khreshchatyk St, 1, Kyiv', "Київ"));
  assert.ok(addressInArea('Ivano-Frankivsk, Ivano-Frankivsk Oblast', 'Івано-Франківськ'));
  assert.ok(addressInArea('Main St, Lviv', 'Lviv Center')); // first word of a multi-word area
  assert.ok(addressInArea('Main St, Yavoriv', 'Яворів') && addressInArea(null, 'Lviv'));
});

test('mergePhotos: owner first, each picture once across sizes and hosts', () => {
  const a = 'https://lh3.googleusercontent.com/p/AAA=s2048';
  const out = mergePhotos([a, 'https://lh3.googleusercontent.com/p/BBB=w800-h600-k-no'], ['https://lh5.googleusercontent.com/p/AAA=w400-h300', 'https://lh3.googleusercontent.com/p/CCC=s2048']);
  assert.deepEqual(out.map((p) => [p.url.split('/p/')[1].slice(0, 3), p.byOwner]), [['AAA', true], ['BBB', true], ['CCC', false]]);
  assert.deepEqual(mergePhotos(undefined, undefined), []);
});

test('toJsonlRow: state is words (judgements computed in code), numbers stay in flat fields', () => {
  const r = toJsonlRow('lead', {
    id: '0x1:0xa', name: 'Перукарня «Єва»', category: 'Hair salon', address: "Kil'tseva St, 1a, Vynnyky, Lviv Oblast, 79495", rating: 4.2, reviewsCount: 127,
    classification: 'no_website', claimed: false, phone: '067 865 2762', placeUrl: 'u', status: 'new',
    reviewTopics: [{ topic: 'polite staff', count: 6 }, { topic: 'price', count: 2 }], services: [{ name: 'x' }], website: null,
  });
  assert.equal(r.state, 'Перукарня «Єва» — Hair salon — Vynnyky. It is an established business with many reviews. Customer ratings are mixed but mostly positive. It has no website at all. The owner has not claimed the Google listing. Reviewers mention: polite staff, price. It lists a phone number.');
  assert.ok(!/\d/.test(r.state)); // no raw numbers, no phone digits, no street
  assert.deepEqual([r.id, r.kind, r.reviewsCount, r.rating, r.phone, r.reviewTopics, 'services' in r, 'website' in r], ['0x1:0xa', 'lead', 127, 4.2, '067 865 2762', 'polite staff (6); price (2)', false, false]);
  // nothing is invented: a bare card (street only, no counts) has no review/website/claimed sentences
  assert.equal(toJsonlRow('card', { name: 'X', placeUrl: 'p', address: "Kil'tseva St, 1a" }).state, 'X.');
  assert.equal(toJsonlRow('card', { name: 'X', placeUrl: 'p' }).id, 'p');
  const rv = toJsonlRow('review', { fid: '0x1:0xa', index: 3, rating: 5, date: 'a week ago', text: 'Great', ownerReply: 'Thanks', author: 'Ann' });
  assert.deepEqual([rv.id, rv.state, rv.author], ['0x1:0xa:3', '5/5 review (a week ago): Great. Owner replied: Thanks', 'Ann']);
  assert.ok(toJsonlRow('review', { index: 0, text: 'x'.repeat(5000) }).state.length <= 1500);
});

test('word bands: reviews, rating, website classes, closed, locality', () => {
  const st = (o) => toJsonlRow('place', { name: 'N', ...o }).state;
  assert.match(st({ reviewsCount: 10 }), /modest number/); // 10 and 127 land in different bands, 10 is not "very few"
  assert.match(st({ reviewsCount: 9 }), /very few/);
  assert.match(st({ reviewsCount: 0 }), /no reviews yet/);
  assert.match(st({ reviewsCount: null }), /no reviews yet/);
  assert.match(st({ reviewsCount: 49 }), /modest/);
  assert.match(st({ reviewsCount: 50 }), /established/);
  assert.match(st({ reviewsCount: 199 }), /established/);
  assert.match(st({ reviewsCount: 200 }), /very popular/);
  assert.match(st({ rating: 4.7 }), /excellent/);
  assert.match(st({ rating: 4.69 }), /very good/);
  assert.match(st({ rating: 4.3 }), /very good/);
  assert.match(st({ rating: 4.29 }), /mixed but mostly positive/);
  assert.match(st({ rating: 3.79 }), /weak/);
  assert.match(st({ classification: 'social_only' }), /only a social media page/);
  assert.match(st({ classification: 'weak_website' }), /template or booking page/);
  assert.match(st({ classification: 'has_website' }), /already has its own website/);
  assert.match(st({ closed: 'permanent' }), /permanently closed/);
  assert.match(st({ closed: 'temporary' }), /temporarily closed/);
  assert.doesNotMatch(st({ claimed: true }), /claimed/);
  assert.equal(localityOf('Main St, Lviv'), 'Lviv');
  assert.equal(localityOf('Khreshchatyk St, 1, Kyiv, 01001, Ukraine'), 'Kyiv');
  assert.equal(localityOf("Kil'tseva St, 1a"), null);
  assert.equal(localityOf(null), null);
});

test('jsonlTarget stays inside home; default name has no colons', () => {
  assert.equal(jsonlTarget('lead', undefined, new Date('2026-10-21T10:15:30Z'), '/home/u'), '/home/u/gmaps-cli-leads/jsonl/leads-2026-10-21T10-15-30.jsonl');
  assert.equal(jsonlTarget('lead', '~/x.jsonl', new Date(), '/home/u'), '/home/u/x.jsonl');
  assert.throws(() => jsonlTarget('lead', '/etc/x.jsonl', new Date(), '/home/u'));
});

test('jsonlOpt accepts stringified booleans and rejects non-.jsonl paths', () => {
  for (const v of [true, 'true', 'TRUE', '1', 'yes']) assert.equal(jsonlOpt(v), true, String(v));
  for (const v of [false, undefined, null, 'false', '0', 'no', '']) assert.equal(jsonlOpt(v), false, String(v));
  assert.equal(jsonlOpt('~/out/x.jsonl'), '~/out/x.jsonl');
  assert.throws(() => jsonlOpt('~/true'));
  assert.throws(() => jsonlOpt('/tmp/x.json'));
  assert.equal(jsonlTarget('lead', 'true', new Date('2026-10-21T10:15:30Z'), '/home/u'), '/home/u/gmaps-cli-leads/jsonl/leads-2026-10-21T10-15-30.jsonl');
});

test('booking hosts are weak across TLDs', () => {
  for (const u of ['https://easyweek.com.ua/bad-uncles-barbershop', 'https://x.easyweek.io', 'https://booksy.com/en/x', 'https://booksy.pl/x', 'https://dikidi.ru/1', 'https://n1.alteg.io/x']) {
    assert.equal(classifyWebsite(u), 'weak_website', u);
  }
  assert.equal(classifyWebsite('https://easyweekly.com'), 'has_website');
});

test('parsePlaceUrl: a competitor without its own coordinates does not inherit the origin\'s', () => {
  const u = 'https://www.google.com/maps/place/Bless+Cuts/@49.84,23.99,17z/data=!4m10!1m7!3m6!1s0x473add706d12064b:0xb2a67bac0701809f!2sFrisor+Lemberg+Barbershop!8m2!3d49.8372!4d24.021561!16s%2Fg%2F1!3m1!1s0x0:0xf742003c8a5486fa?hl=en';
  assert.deepEqual(parsePlaceUrl(u), { lat: null, lng: null, fid: '0x0:0xf742003c8a5486fa', placeId: '0x0:0xf742003c8a5486fa' });
  assert.equal(parsePlaceUrl('https://www.google.com/maps/place/X/@50.1,30.2,17z/data=!4m2!3m1!1s0x1:0xa').lat, 50.1); // single place: viewport fallback
});

test('leadScore: weights, band edges, closed, ordering', () => {
  const A = { classification: 'no_website', reviewsCount: 127, rating: 4.2, claimed: false, phone: '067' };
  const B = { classification: 'social_only', reviewsCount: 10, rating: 3.8, claimed: true, phone: '067' };
  assert.deepEqual(leadScore(A), { score: 86, reasons: ['no website', 'established (many reviews)', 'mixed rating', 'listing unclaimed', 'has phone'] });
  assert.ok(leadScore(A).score > leadScore(B).score); // the 10-review salon must not beat the 127-review one
  assert.equal(leadScore({ ...A, closed: 'temporary' }).score, 0);
  assert.deepEqual(leadScore({ ...A, closed: 'permanent' }).reasons, ['closed']);
  assert.equal(leadScore({ classification: 'no_website', reviewsCount: 200, rating: 4.7, claimed: false, phone: 'x' }).score, 100);
  const pts = (o) => leadScore(o).score;
  assert.deepEqual([0, 1, 9, 10, 49, 50, 199, 200].map((n) => pts({ reviewsCount: n, rating: 0 })), [0, 5, 5, 15, 15, 25, 25, 30]);
  assert.deepEqual([4.7, 4.69, 4.3, 4.29, 3.8, 3.79, null].map((r) => pts({ rating: r })), [15, 12, 12, 6, 6, 0, 3]);
  assert.deepEqual(['no_website', 'weak_website', 'social_only', 'has_website', null].map((c) => pts({ classification: c, rating: 0 })), [40, 32, 30, 0, 0]);
  const rows = [{ leadScore: 50, reviewsCount: 5 }, { leadScore: 80, reviewsCount: 1 }, { leadScore: 50, reviewsCount: 9 }].sort(byScore);
  assert.deepEqual(rows.map((r) => r.reviewsCount), [1, 9, 5]);
});

test('agoToDays and summarizeActivity', () => {
  const t = (x) => agoToDays(x);
  assert.deepEqual(['just now', '5 minutes ago', '3 hours ago', 'a day ago', '2 days ago', 'a week ago', '3 weeks ago', 'a month ago', '2 months ago', 'a year ago', '3 years ago', 'Edited 5 months ago', 'an hour ago', 'a month ago on Google'].map(t),
    [0, 0, 0, 1, 2, 7, 21, 30, 60, 365, 1095, 150, 0, 30]);
  assert.equal(t('yesterday'), null);
  assert.equal(t(null), null);
  assert.deepEqual(summarizeActivity([{ date: 'a week ago', replied: true }, { date: '2 months ago', replied: true }, { date: '3 months ago', replied: false }, { date: '2 years ago', replied: false }]),
    { lastReviewAgo: 'a week ago', lastReviewDays: 7, recentReviews90d: 3, ownerReplyRate: 0.5, sampled: 4 });
  assert.equal(summarizeActivity([]), null);
  assert.equal(summarizeActivity([{ date: '???', replied: false }]).lastReviewDays, null);
});

test('leadScore activity: recent +5, inactive -15, owner replies +5, clamped', () => {
  const base = { classification: 'no_website', reviewsCount: 127, rating: 4.2, claimed: false, phone: '1' }; // 86
  assert.equal(leadScore({ ...base, activity: { lastReviewDays: 90, ownerReplyRate: 0, sampled: 10 } }).score, 91);
  assert.deepEqual(leadScore({ ...base, activity: { lastReviewDays: 91, ownerReplyRate: 0.5, sampled: 3 } }).score, 91); // 0 for 91..365, +5 replies
  assert.deepEqual(leadScore({ ...base, activity: { lastReviewDays: 366, ownerReplyRate: 0, sampled: 10 } }), { score: 71, reasons: [...leadScore(base).reasons, 'inactive (no reviews in a year)'] });
  assert.equal(leadScore({ ...base, activity: { lastReviewDays: null, ownerReplyRate: 0.4, sampled: 10 } }).score, 86);
  assert.equal(leadScore({ ...base, activity: { lastReviewDays: 5, ownerReplyRate: 1, sampled: 2 } }).score, 91); // too few samples for the reply bonus
  assert.equal(leadScore({ classification: 'no_website', reviewsCount: 300, rating: 4.9, claimed: false, phone: '1', activity: { lastReviewDays: 1, ownerReplyRate: 1, sampled: 10 } }).score, 100);
  assert.equal(leadScore({ classification: 'has_website', activity: { lastReviewDays: 500, sampled: 5, ownerReplyRate: 0 } }).score, 0);
  const row = toJsonlRow('lead', { name: 'N', activity: { lastReviewDays: 5, ownerReplyRate: 1, sampled: 5 } });
  assert.match(row.state, /recent reviews\. The owner replies to reviews\./);
  assert.deepEqual([row.lastReviewDays, row.ownerReplyRate, 'activity' in row], [5, 1, false]);
  assert.match(toJsonlRow('lead', { name: 'N', activity: { lastReviewDays: 400, sampled: 5, ownerReplyRate: 0 } }).state, /no reviews for over a year/);
});

test('gridTiles: n x n tile centers around the viewport at zoom + log2(n)', () => {
  assert.deepEqual(gridTiles({ lat: 50, lng: 30, zoom: 13 }, 1), [{ lat: 50, lng: 30, zoom: 13 }]);
  const t = gridTiles({ lat: 49.84, lng: 24.03, zoom: 13 }, 2);
  assert.equal(t.length, 4);
  assert.ok(t.every((x) => x.zoom === 14));
  const mean = (k) => t.reduce((a, x) => a + x[k], 0) / 4;
  assert.ok(Math.abs(mean('lat') - 49.84) < 1e-5 && Math.abs(mean('lng') - 24.03) < 1e-5);
  assert.ok(t[0].lat > t[2].lat && t[0].lng < t[1].lng); // row-major, north-west first
  const span = Math.abs(t[1].lng - t[0].lng); // half of 1000 px at zoom 13: 500 * 360 / (256 * 2^13)
  assert.ok(Math.abs(span - (500 * 360) / (256 * 2 ** 13)) < 1e-4);
  assert.equal(gridTiles({ lat: 0, lng: 0, zoom: 12 }, 3).length, 9);
  assert.equal(gridTiles({ lat: 0, lng: 0, zoom: 12 }, 3)[0].zoom, 13.58);
});

test('unwrapGoogleRedirect: ad links give their target or null, real sites pass through', () => {
  assert.equal(unwrapGoogleRedirect('https://www.google.com/aclk?sa=l&ai=x&adurl=https%3A%2F%2Felektra.example%2Fpage'), 'https://elektra.example/page');
  assert.equal(unwrapGoogleRedirect('https://www.google.com/aclk?sa=l&ai=x&adurl='), null);
  assert.equal(unwrapGoogleRedirect('https://www.google.com/aclk?sa=l&adurl=javascript:alert(1)'), null);
  assert.equal(unwrapGoogleRedirect('https://www.google.com.ua/url?q=https%3A%2F%2Fa.com%2F&sa=U'), 'https://a.com/');
  assert.equal(unwrapGoogleRedirect('https://www.google.com/pagead/aclk?x=1'), null);
  assert.equal(unwrapGoogleRedirect('https://sites.google.com/view/x'), 'https://sites.google.com/view/x');
  assert.equal(unwrapGoogleRedirect('https://example.com/a?adurl=https://evil.com'), 'https://example.com/a?adurl=https://evil.com');
  assert.equal(unwrapGoogleRedirect(null), null);
});

test('viewportOfCards: center and zoom from the cards coordinates', () => {
  const u = (lat, lng) => ({ placeUrl: `https://www.google.com/maps/place/x/data=!1s0x1:0x2!3d${lat}!4d${lng}` });
  assert.equal(viewportOfCards([{ name: 'no coords', placeUrl: 'https://www.google.com/maps/place/x' }]), null);
  assert.equal(viewportOfCards([]), null);
  const v = viewportOfCards([u(49.80, 23.95), u(49.88, 24.10)]);
  assert.ok(Math.abs(v.lat - 49.84) < 1e-6 && Math.abs(v.lng - 24.025) < 1e-6);
  assert.ok(v.zoom >= 11 && v.zoom <= 13, String(v.zoom)); // ~0.15 deg wide
  assert.equal(viewportOfCards([u(49.8, 24)]).zoom, 16); // a single card: capped
  assert.ok(viewportOfCards([{ lat: 10, lng: 10 }, { lat: 60, lng: 100 }]).zoom >= 3);
});

test('mapPopularTimes: names groups by open days when some days are closed', () => {
  const g = (today) => ({ day: null, today: !!today, hours: [] });
  const hours = { Monday: '9 AM–6 PM', Tuesday: '9 AM–6 PM', Wednesday: '9 AM–6 PM', Thursday: '9 AM–6 PM', Friday: '9 AM–6 PM', Saturday: 'Closed', Sunday: 'Closed' };
  const wed = new Date('2026-10-21T12:00:00'); // a Wednesday
  const m = mapPopularTimes([g(), g(), g(true), g(), g()], hours, wed);
  assert.deepEqual(m.map((x) => x.day), ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']);
  // the visible group does not match today's weekday: no guess
  assert.deepEqual(mapPopularTimes([g(true), g(), g(), g(), g()], hours, wed).map((x) => x.day), [null, null, null, null, null]);
  assert.equal(mapPopularTimes([g(), g()], hours, wed)[0].day, null); // count mismatch
  const seven = [...Array(7)].map((_, i) => ({ day: 'D' + i, today: false, hours: [] }));
  assert.equal(mapPopularTimes(seven, hours, wed), seven); // already named
  assert.deepEqual(mapPopularTimes(undefined, hours), []);
});

test('haversineKm, zoomForRadius, parseCenter, plusCodeFromLines', () => {
  assert.ok(Math.abs(haversineKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }) - 111.19) < 0.05);
  assert.ok(Math.abs(haversineKm({ lat: 49.84, lng: 24.03 }, { lat: 49.85, lng: 24.03 }) - 1.112) < 0.01);
  assert.equal(haversineKm({ lat: 10, lng: 10 }, { lat: 10, lng: 10 }), 0);
  const z = (km, lat) => zoomForRadius(km, lat);
  assert.ok(z(1, 50) > z(5, 50) && z(5, 50) > z(20, 50)); // bigger circle, smaller zoom
  assert.ok(z(5, 0) > z(5, 60)); // ground per pixel shrinks with cos(lat), so higher latitudes need a lower zoom
  assert.equal(z(0.01, 50), 19);
  assert.equal(z(50000, 0), 3);
  // the circle fits: the diameter + 10% is within 800 px at the returned zoom
  const kmPerPx = (zoom, lat) => (40075.016 * Math.cos((lat * Math.PI) / 180)) / (256 * 2 ** zoom);
  assert.ok(800 * kmPerPx(z(5, 49.84), 49.84) >= 2 * 5 * 1.1 - 1e-6);
  assert.deepEqual(parseCenter('49.84, 24.03'), { lat: 49.84, lng: 24.03 });
  assert.deepEqual(parseCenter({ lat: -33.9, lng: 151.2 }), { lat: -33.9, lng: 151.2 });
  for (const bad of ['91,0', '0,181', '1', '1,2,3', 'a,b', ',5', { lat: 'x', lng: 1 }, { lat: 1 }, null, undefined, '']) assert.throws(() => parseCenter(bad), undefined, JSON.stringify(bad));
  assert.deepEqual(plusCodeFromLines(["49°50'13.9\"N 24°01'17.6\"E", '49.837200, 24.021561', 'R2PC+VJF Lviv, Lviv Oblast', 'Add a missing place']), { plusCode: 'R2PC+VJF', locality: 'Lviv, Lviv Oblast' });
  assert.deepEqual(plusCodeFromLines(['R2PC+VJ']), { plusCode: 'R2PC+VJ', locality: null });
  assert.deepEqual(plusCodeFromLines(['Add a missing place', 'hello+world']), { plusCode: null, locality: null });
  assert.deepEqual(plusCodeFromLines(undefined), { plusCode: null, locality: null });
});

test('distance bands in state and flat distanceKm', () => {
  const st = (d) => toJsonlRow('lead', { name: 'N', distanceKm: d }).state;
  assert.match(st(0.5), /very close \(under 1 km\)/);
  assert.match(st(1), /nearby \(1-5 km\)/);
  assert.match(st(5), /nearby/);
  assert.match(st(5.01), /farther away \(over 5 km\)/);
  assert.doesNotMatch(toJsonlRow('lead', { name: 'N' }).state, /close|nearby|farther/);
  assert.equal(toJsonlRow('lead', { name: 'N', distanceKm: 2.5 }).distanceKm, 2.5);
});

test('stripVisited removes the visited-link marker', () => {
  assert.equal(stripVisited('Frisor Lemberg Barbershop · Visited link'), 'Frisor Lemberg Barbershop');
  assert.equal(stripVisited('Frisor Lemberg Barbershop ⋅ Visited link'), 'Frisor Lemberg Barbershop');
  assert.equal(stripVisited('Visited link'), null);
  assert.equal(stripVisited(''), null);
  assert.equal(stripVisited(null), null);
  assert.equal(stripVisited('Hair salon'), 'Hair salon');
  assert.equal(stripVisited('Visited links of salons'), 'Visited links of salons');
});
