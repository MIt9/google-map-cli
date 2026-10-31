// Persistent job queue (pure logic, no WebSocket): used by the primary server, tested by queue.test.js.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DIR = process.env.GMAPS_CLI_DIR || path.join(os.homedir(), '.gmaps-cli');
export const QUEUE_FILE = path.join(DIR, 'queue.json');
export const ACTIONS_FILE = path.join(DIR, 'actions.jsonl');
export const LEADS_FILE = path.join(DIR, 'leads.jsonl');

// Internal handler names (extension/background.js `handlers`). All read-only on Google's side, so they may be retried;
// `click` can have side effects on the page, so it is never retried.
export const BROWSER = new Set(['search', 'getPlace', 'getReviews', 'getPhotos', 'getCompetitors', 'getPoint', 'clickPoi', 'readPage', 'snapshot', 'scroll']);
// Server-side orchestrators: they run outside the single worker and enqueue each browser step as its own job.
export const COMPOSITE = new Set(['findLeads', 'downloadPlace', 'competitors', 'placeAt']);
export const HANDLERS = new Set([...BROWSER, ...COMPOSITE, 'click']);

const FINAL = new Set(['done', 'failed', 'unverified', 'cancelled']);
export const isFinal = (j) => FINAL.has(j.status);
const MAX_RETRIES = 2; // browser reads: 1 try + 2 retries
const RETRY_DELAY_MS = 2000;
const KEEP_FINAL = 500; // ponytail: prune oldest finished jobs beyond this; dedupe by key only sees what is kept

// Extension is halted (captcha / consent wall): the worker pauses until Resume in the popup.
export const isHalt = (error) => /^HALT:/.test(error || '');
// Outcome unknown: the click may have happened.
const isAmbiguous = (error) => /^Extension disconnected|timed out$/.test(error || '');

export class Queue {
  constructor(file = QUEUE_FILE, now = Date.now) {
    this.file = file;
    this.now = now;
    this.jobs = new Map();
    this.nextId = 1;
  }

  // Load from disk. Jobs left `running` by a dead primary: browser reads and composites -> queued (composites are
  // idempotent: known leads are skipped), click -> unverified. Steps of an interrupted composite are cancelled.
  load() {
    let data = {};
    try { data = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (err) { if (err.code !== 'ENOENT') throw new Error(`Cannot load queue ${this.file}: ${err.message}`); }
    if (!data || typeof data !== 'object' || (data.jobs !== undefined && !Array.isArray(data.jobs))) throw new Error(`Invalid queue data: ${this.file}`);
    this.nextId = data.nextId || 1;
    for (const j of data.jobs || []) {
      if (j.status === 'running' || j.status === 'queued') {
        if (j.parent) { j.status = 'cancelled'; j.error = 'parent job interrupted by restart'; j.updatedAt = this.now(); }
        else if (j.status === 'running') {
          j.updatedAt = this.now();
          if (j.tool === 'click') { j.status = 'unverified'; j.error = 'server restarted while running; may have been executed'; }
          else j.status = 'queued';
        }
      }
      this.jobs.set(j.id, j);
      this.nextId = Math.max(this.nextId, j.id + 1);
    }
    this.save();
    return this;
  }

  save() {
    const final = [...this.jobs.values()].filter(isFinal);
    for (const j of final.slice(0, Math.max(0, final.length - KEEP_FINAL))) this.jobs.delete(j.id);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ nextId: this.nextId, jobs: [...this.jobs.values()] }));
    fs.renameSync(tmp, this.file);
  }

  // Same `key` as a job that is not failed/cancelled -> that job. `parent` = composite job id owning this step.
  enqueue({ tool, args = {}, key, priority = 0, notBefore, parent }) {
    if (key) {
      const dup = [...this.jobs.values()].find((j) => j.key === key && j.status !== 'failed' && j.status !== 'cancelled');
      if (dup) return dup;
    }
    const t = this.now();
    const job = { id: this.nextId++, key, parent, tool, args, priority, notBefore, status: 'queued', attempts: 0, createdAt: t, updatedAt: t };
    this.jobs.set(job.id, job);
    this.save();
    return job;
  }

  get(id) { return this.jobs.get(id); }

  // Newest first.
  list({ status, limit = 50 } = {}) {
    return [...this.jobs.values()].filter((j) => !status || j.status === status).reverse().slice(0, limit);
  }

  cancel(id) {
    const j = this.jobs.get(id);
    if (!j) throw new Error(`No job ${id}`);
    if (j.status !== 'queued') throw new Error(`Job ${id} is ${j.status}; only queued jobs can be cancelled`);
    j.status = 'cancelled';
    j.updatedAt = this.now();
    this.save();
    return j;
  }

  // Due queued job: priority desc, then FIFO (ids are monotonic). `composite` picks orchestrators instead of
  // worker jobs. Priority only decides which job is picked NEXT; it never interrupts a running one.
  next(composite = false) {
    const t = this.now();
    let best = null;
    for (const j of this.jobs.values()) {
      if (j.status !== 'queued' || (j.notBefore && j.notBefore > t) || COMPOSITE.has(j.tool) !== composite) continue;
      if (!best || j.priority > best.priority) best = j; // map order = id order, so ties keep the oldest
    }
    return best;
  }

  // Earliest notBefore among queued jobs still waiting.
  wakeAt() {
    const t = this.now();
    const ts = [...this.jobs.values()].filter((j) => j.status === 'queued' && j.notBefore > t).map((j) => j.notBefore);
    return ts.length ? Math.min(...ts) : null;
  }

  start(job) {
    job.status = 'running';
    job.attempts++;
    job.updatedAt = this.now();
    this.save();
    return job;
  }

  // outcome: { result } | { error }
  complete(id, { result, error }) {
    const j = this.jobs.get(id);
    const t = (j.updatedAt = this.now());
    if (error === undefined) {
      j.result = result;
      j.status = 'done';
      delete j.error;
    } else {
      j.error = error;
      if (isHalt(error)) {
        // Not completed. Enqueued work waits for Resume; a sync caller gets the error now.
        j.attempts = Math.max(0, j.attempts - 1);
        j.status = j.priority === 0 ? 'queued' : 'failed';
      } else if (isAmbiguous(error) && j.tool === 'click') j.status = 'unverified';
      else if (BROWSER.has(j.tool) && j.attempts <= MAX_RETRIES) {
        j.status = 'queued';
        j.notBefore = t + RETRY_DELAY_MS;
      } else j.status = 'failed';
    }
    this.save();
    return j;
  }
}
