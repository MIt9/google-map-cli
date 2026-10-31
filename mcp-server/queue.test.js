// Run: node --test (or node queue.test.js)
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Queue } from './queue.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmcp-'));
let clock = 1000;
const mk = (name) => new Queue(path.join(dir, `${name}.json`), () => clock).load();
const run = (q, job, outcome) => q.complete(q.start(job).id, outcome);

test('corrupt queue is preserved and not silently replaced', () => {
  const file = path.join(dir, 'corrupt.json');
  fs.writeFileSync(file, '{broken');
  assert.throws(() => new Queue(file).load());
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('priority 1 first, FIFO within a priority, composites are not worker jobs', () => {
  const q = mk('prio');
  const a = q.enqueue({ tool: 'search', priority: 0 });
  const b = q.enqueue({ tool: 'search', priority: 0 });
  const c = q.enqueue({ tool: 'getPlace', priority: 1 });
  const f = q.enqueue({ tool: 'findLeads', priority: 1 });
  const order = [];
  for (let j; (j = q.next()); ) { order.push(j.id); run(q, j, { result: 1 }); }
  assert.deepEqual(order, [c.id, a.id, b.id]);
  assert.equal(q.next(true).id, f.id);
});

test('priority never interrupts the running job', () => {
  const q = mk('norun');
  const a = q.enqueue({ tool: 'search' });
  const b = q.enqueue({ tool: 'search' });
  q.start(q.next());
  const p = q.enqueue({ tool: 'getPlace', priority: 1 });
  assert.equal(a.status, 'running');
  assert.equal(q.next().id, p.id);
  q.complete(a.id, { result: 1 });
  run(q, q.next(), { result: 1 });
  assert.equal(q.next().id, b.id);
});

test('dedupe by key; failed/cancelled keys can be reused', () => {
  const q = mk('dedupe');
  const a = q.enqueue({ tool: 'search', key: 'k' });
  assert.equal(q.enqueue({ tool: 'search', key: 'k' }).id, a.id);
  q.cancel(a.id);
  const b = q.enqueue({ tool: 'click', key: 'k' });
  assert.notEqual(b.id, a.id);
  run(q, b, { error: 'boom' }); // click is never retried
  assert.equal(b.status, 'failed');
  assert.notEqual(q.enqueue({ tool: 'click', key: 'k' }).id, b.id);
});

test('HALT: enqueued job waits, sync job fails, attempt not counted', () => {
  const q = mk('halt');
  const w = q.enqueue({ tool: 'search', priority: 0 });
  run(q, w, { error: 'HALT: captcha' });
  assert.equal(w.status, 'queued');
  assert.equal(w.attempts, 0);
  const s = q.enqueue({ tool: 'search', priority: 1 });
  run(q, s, { error: 'HALT: captcha' });
  assert.equal(s.status, 'failed');
});

test('notBefore delays a job; browser reads retry twice then fail', () => {
  const q = mk('retry');
  const d = q.enqueue({ tool: 'search', notBefore: 5000 });
  assert.equal(q.next(), null);
  assert.equal(q.wakeAt(), 5000);
  clock = 5000;
  assert.equal(q.next().id, d.id);
  run(q, d, { result: 1 });
  const j = q.enqueue({ tool: 'getPlace' });
  for (let i = 0; i < 2; i++) { run(q, j, { error: 'flaky' }); assert.equal(j.status, 'queued'); clock += 5000; }
  run(q, j, { error: 'flaky' });
  assert.equal(j.status, 'failed');
  assert.equal(j.attempts, 3);
  clock = 1000;
});

test('restart recovery', () => {
  const q = mk('restart');
  const r = q.enqueue({ tool: 'getPlace' });
  const c = q.enqueue({ tool: 'click' });
  const f = q.enqueue({ tool: 'findLeads' });
  const step = q.enqueue({ tool: 'search', parent: f.id });
  [r, c, f, step].forEach((j) => q.start(j));
  const q2 = new Queue(q.file, () => clock).load();
  assert.equal(q2.get(r.id).status, 'queued');
  assert.equal(q2.get(c.id).status, 'unverified');
  assert.equal(q2.get(f.id).status, 'queued'); // composite reruns
  assert.equal(q2.get(step.id).status, 'cancelled'); // its orphaned step does not
  assert.equal(q2.enqueue({ tool: 'search' }).id, step.id + 1);
  fs.rmSync(dir, { recursive: true });
});
