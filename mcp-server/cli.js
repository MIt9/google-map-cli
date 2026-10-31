#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const commands = ['status','search','get-place','get-reviews','get-photos','download-place','find-leads','competitors','place-at','leads','check-website','export-leads','snapshot','read-page','click','scroll','enqueue','queue'];
const api = `http://127.0.0.1:${Number(process.env.GMAPS_CLI_API_PORT) || 47833}`;
const args = process.argv.slice(2);
const command = args.shift();
async function request(path, init) {
  const r = await fetch(api + path, init);
  const value = await r.json();
  if (!r.ok) throw new Error(value.error || `HTTP ${r.status}`);
  return value;
}
try {
  if (!command || command === '--help' || command === '-h') {
    console.log('Usage: gmaps <command> [--option value] [--json JSON]\nCommands: service-start, service-stop, ' + commands.join(', ') + '\nRun gmaps <command> --help for details.');
  } else if ((command === 'service-start' || command === 'service-stop') && (args.includes('--help') || args.includes('-h'))) {
    console.log(`Usage: gmaps ${command}\n${command === 'service-start' ? 'Start the local service if it is not running.' : 'Stop the service when no jobs or requests are active; queued jobs remain saved.'}`);
  } else if (command === 'service-stop') {
    console.log(JSON.stringify(await request('/stop', { method: 'POST' })));
  } else if (command === 'service-start') {
    try {
      await request('/commands');
      console.log(JSON.stringify({ started: false, alreadyRunning: true }));
      process.exit(0);
    } catch {}
    const child = spawn(process.execPath, [fileURLToPath(new URL('./index.js', import.meta.url))], { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try { await request('/commands'); ready = true; break; } catch { await new Promise(r => setTimeout(r, 100)); }
    }
    if (!ready) throw new Error('Service did not start');
    console.log(JSON.stringify({ started: true, pid: child.pid }));
  } else {
    if (!commands.includes(command)) throw new Error(`Unknown command: ${command}`);
    const name = 'gmaps_' + command.replaceAll('-', '_');
    const help = args.includes('--help') || args.includes('-h');
    const specs = help ? JSON.parse(spawnSync(process.execPath, [fileURLToPath(new URL('./index.js', import.meta.url)), '--catalog'], { encoding: 'utf8' }).stdout) : await request('/commands');
    const spec = specs.find(x => x.name === name);
    if (!spec) throw new Error('Command unavailable in service');
    if (help) {
      const clean = s => (s || '').replaceAll('~/.gmaps-mcp', '~/.gmaps-cli').replaceAll('~/gmaps-leads', '~/gmaps-cli-leads').replace(/gmaps_([a-z_]+)/g, (_, n) => 'gmaps ' + n.replaceAll('_', '-'));
      console.log(`Usage: gmaps ${command} [options]\n${clean(spec.description)}`);
      for (const opt of spec.options) {
        const s = opt.schema;
        const type = s.enum ? s.enum.join('|') : (Array.isArray(s.type) ? s.type.join('|') : s.type || (s.anyOf ? 'string|object' : 'value'));
        const bounds = [s.minimum != null ? `min ${s.minimum}` : '', s.maximum != null ? `max ${s.maximum}` : '', s.maxItems != null ? `max ${s.maxItems} items` : ''].filter(Boolean).join(', ');
        console.log(`  --${opt.key.replace(/[A-Z]/g, x => '-' + x.toLowerCase())} <${type}>${opt.required ? ' (required)' : ''}${bounds ? ` [${bounds}]` : ''}  ${clean(opt.description || s.description)}`);
      }
      console.log('  --json <object>  Provide the complete command arguments as JSON.');
    } else {
      let input = {};
      while (args.length) {
        const flag = args.shift();
        if (!flag.startsWith('--')) throw new Error(`Expected option, got ${flag}`);
        if (flag === '--json' || (flag === '--args' && command !== 'enqueue')) { const v = args.shift(); input = { ...input, ...JSON.parse(v) }; continue; }
        if (flag === '--args' && command === 'enqueue') {
          const v = JSON.parse(args.shift());
          if (v && typeof v === 'object' && 'tool' in v && 'args' in v) input = { ...input, ...v }; // legacy whole-command form
          else input.args = v;
          continue;
        }
        const negative = flag.startsWith('--no-');
        const key = flag.slice(negative ? 5 : 2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        const option = spec.options.find(x => x.key === key);
        if (!option) throw new Error(`Unknown option ${flag}`);
        let value;
        if (negative) {
          if (option.schema.type !== 'boolean' && !option.schema.type?.includes?.('boolean')) throw new Error(`${flag} requires a boolean option`);
          value = false;
        }
        else if (!args.length || args[0].startsWith('--')) value = true;
        else {
          const raw = args.shift();
          const type = option.schema.type;
          if (type === 'number' || type === 'integer') { value = Number(raw); if (!Number.isFinite(value)) throw new Error(`Invalid number for ${flag}`); }
          else if (type === 'array' || type === 'object' || ((type === 'boolean' || (Array.isArray(type) && type.includes('boolean'))) && (raw === 'true' || raw === 'false'))) value = JSON.parse(raw);
          else value = raw;
        }
        input[key] = value;
      }
      const out = await request('/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, args: input }) });
      console.log(JSON.stringify(out, null, 2));
    }
  }
} catch (e) { console.error(e.cause?.code === 'ECONNREFUSED' ? 'Service unavailable; run gmaps service-start' : e.message); process.exitCode = 1; }
