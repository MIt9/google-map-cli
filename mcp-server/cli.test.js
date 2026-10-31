import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

test('CLI help lists status and search commands', () => {
  const r = spawnSync(process.execPath, ['cli.js', '--help'], { cwd: import.meta.dirname, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /status/);
  assert.match(r.stdout, /search/);
});

test('command help works offline and explains required options without raw schemas', () => {
  const env = { ...process.env, GMAPS_CLI_API_PORT: '1' };
  const r = spawnSync(process.execPath, ['cli.js', 'find-leads', '--help'], { cwd: import.meta.dirname, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--query.*required/);
  assert.doesNotMatch(r.stdout, /\$schema|gmaps-mcp|gmaps_enqueue/);
});

test('service-stop refuses to interrupt a running browser job', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gmaps-active-'));
  const port = 49000 + Math.floor(Math.random() * 500);
  const env = { ...process.env, GMAPS_CLI_API_PORT: String(port), GMAPS_CLI_WS_PORT: String(port + 1000), GMAPS_CLI_DIR: dir };
  const service = spawn(process.execPath, ['index.js'], { cwd: import.meta.dirname, env, stdio: 'ignore' });
  let socket;
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/commands`)).ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    socket = new WebSocket(`ws://127.0.0.1:${port + 1000}`, { origin: 'chrome-extension://test' });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify({ type: 'hello', version: '0.1.22' }));
    const action = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No browser job received')), 5000);
      socket.on('message', bytes => {
        const msg = JSON.parse(bytes);
        if (msg.id != null) { clearTimeout(timer); resolve(msg); }
      });
    });
    const result = await fetch(`http://127.0.0.1:${port}/call`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'gmaps_enqueue', args: { tool: 'search', args: { query: 'test' } } }),
    });
    assert.equal(result.status, 200);
    const job = await action;
    const stop = await fetch(`http://127.0.0.1:${port}/stop`, { method: 'POST' });
    assert.equal(stop.status, 409);
    socket.send(JSON.stringify({ id: job.id, result: { cards: [] } }));
  } finally {
    socket?.close();
    service.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('service exposes status, validation and an isolated lead list through the CLI', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gmaps-cli-'));
  const port = 48000 + Math.floor(Math.random() * 500);
  const env = { ...process.env, GMAPS_CLI_API_PORT: String(port), GMAPS_CLI_WS_PORT: String(port + 1000), GMAPS_CLI_DIR: dir };
  const service = spawn(process.execPath, ['index.js'], { cwd: import.meta.dirname, env, stdio: 'ignore' });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(`http://127.0.0.1:${port}/commands`); if (r.ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, 'service did not start');
    const run = (...args) => spawnSync(process.execPath, ['cli.js', ...args], { cwd: import.meta.dirname, env, encoding: 'utf8' });
    const catalog = await (await fetch(`http://127.0.0.1:${port}/commands`)).json();
    assert.equal(catalog.length, 18);
    for (const entry of catalog) {
      const command = entry.name.slice(6).replaceAll('_', '-');
      const help = run(command, '--help');
      assert.equal(help.status, 0, `${command}: ${help.stderr}`);
      for (const option of entry.options) {
        const flag = '--' + option.key.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
        assert.ok(help.stdout.includes(flag), `${command} help missing ${flag}`);
      }
      const invalid = run(command, '--this-option-does-not-exist', 'x');
      assert.notEqual(invalid.status, 0, command);
    }
    const status = run('status');
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).dir, dir);
    const leads = run('leads', '--action', 'list');
    assert.equal(leads.status, 0, leads.stderr);
    assert.equal(JSON.parse(leads.stdout).count, 0);
    const bad = run('search', '--limit', '121');
    assert.notEqual(bad.status, 0);
    assert.ok(bad.stderr);
    const queued = run('enqueue', '--args', '{"tool":"search","args":{"query":"test"}}');
    assert.equal(queued.status, 0, queued.stderr);
    const jobId = JSON.parse(queued.stdout).jobId;
    const nested = run('enqueue', '--tool', 'search', '--args', '{"query":"second"}');
    assert.equal(nested.status, 0, nested.stderr);
    const nestedJob = run('queue', '--action', 'get', '--id', String(JSON.parse(nested.stdout).jobId));
    assert.equal(JSON.parse(nestedJob.stdout).args.query, 'second');
    const stop = run('service-stop');
    assert.equal(stop.status, 0, stop.stderr);
    await new Promise(resolve => service.once('exit', resolve));
    const restarted = spawn(process.execPath, ['index.js'], { cwd: import.meta.dirname, env, stdio: 'ignore' });
    try {
      for (let i = 0; i < 100; i++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/commands`)).ok) break; } catch {}
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const job = run('queue', '--action', 'get', '--id', String(jobId));
      assert.equal(job.status, 0, job.stderr);
      assert.equal(JSON.parse(job.stdout).status, 'queued');
    } finally { restarted.kill(); }
  } finally {
    service.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
