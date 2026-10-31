#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const commands = ['status','search','get-place','get-reviews','get-photos','download-place','find-leads','competitors','place-at','leads','check-website','export-leads','snapshot','read-page','click','scroll','enqueue','queue'];
const api = `http://127.0.0.1:${Number(process.env.GMAPS_CLI_API_PORT) || 47833}`;

// Format selection: --text (global) -> GMAPS_CLI_FORMAT -> TTY -> text, else JSON.
const rawArgs = process.argv.slice(2);
let forcedText = false;
const args = [];
for (const a of rawArgs) {
  if (a === '--text') { forcedText = true; continue; }
  args.push(a);
}
const envFmt = process.env.GMAPS_CLI_FORMAT;
let textMode = forcedText;
if (envFmt === 'text') textMode = true;
else if (envFmt === 'json') textMode = false;
else if (envFmt == null || envFmt === '') textMode = textMode || !!process.stdout.isTTY;

function renderText(value, indent = 0) {
  const pad = '  '.repeat(indent);
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    const s = value.length > 200 ? value.slice(0, 200) + '…' : value;
    return pad + s;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return pad + String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return pad + '(empty)';
    return value.map((v, i) => `${pad}${i + 1}. ${renderText(v, 0).trimStart()}`).join('\n');
  }
  if (typeof value === 'object') {
    const lines = [];
    for (const [k, v] of Object.entries(value)) {
      if (v !== null && typeof v === 'object') {
        lines.push(`${pad}${k}:`);
        const nested = renderText(v, indent + 1).trimEnd();
        if (nested) lines.push(nested);
      } else {
        lines.push(`${pad}${k}: ${v === null || v === undefined ? '' : v}`);
      }
    }
    return lines.join('\n');
  }
  return pad + String(value);
}

const command = args.shift();
async function request(path, init) {
  const r = await fetch(api + path, init);
  const value = await r.json();
  if (!r.ok) throw new Error(value.error || `HTTP ${r.status}`);
  return value;
}
function fail(e) {
  const msg = e?.cause?.code === 'ECONNREFUSED' ? 'Service unavailable; run gmaps service-start' : (e?.message || String(e));
  const hint = e?.cause?.code === 'ECONNREFUSED' ? 'run gmaps service-start' : null;
  if (textMode) {
    console.error(`Error: ${msg}`);
    if (hint) console.error(`Hint: ${hint}`);
  } else {
    console.error(JSON.stringify({ error: msg }));
  }
  process.exitCode = 1;
}
try {
  if (!command || command === '--help' || command === '-h') {
    console.log('Usage: gmaps <command> [--option value] [--json JSON]\nCommands: service-start, service-stop, config, ' + commands.join(', ') + '\nRun gmaps <command> --help for details.');
  } else if (command === 'config') {
    const sub = args.shift();
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const dir = process.env.GMAPS_CLI_DIR || path.join(os.homedir(), '.gmaps-cli');
    const cfgPath = path.join(dir, 'config.json');
    function readCfg() { try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { return {}; } }
    function writeCfg(c) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.writeFileSync(cfgPath, JSON.stringify(c, null, 2), { mode: 0o600 }); }
    if (sub === 'get') {
      const c = readCfg(); const out = { port: c.port ?? null };
      console.log(textMode ? renderText(out) : JSON.stringify(out, null, 2));
    } else if (sub === 'set') {
      const key = args.shift(); const val = args.shift();
      if (key !== 'port') throw new Error('Only "port" is supported');
      const port = Number(val);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1-65535');
      const c = readCfg(); c.port = port; writeCfg(c);
      const out = { port };
      console.log(textMode ? renderText(out) : JSON.stringify(out, null, 2));
    } else if (sub === 'unset') {
      const key = args.shift();
      if (key !== 'port') throw new Error('Only "port" is supported');
      const c = readCfg(); delete c.port; writeCfg(c);
      const out = { port: null };
      console.log(textMode ? renderText(out) : JSON.stringify(out, null, 2));
    } else {
      console.log('Usage: gmaps config get|set|unset port [value]');
    }
  } else if ((command === 'service-start' || command === 'service-stop') && (args.includes('--help') || args.includes('-h'))) {
    console.log(`Usage: gmaps ${command}\n${command === 'service-start' ? 'Start the local service if it is not running.' : 'Stop the service when no jobs or requests are active; queued jobs remain saved.'}`);
  } else if (command === 'service-stop') {
    const out = await request('/stop', { method: 'POST' });
    console.log(textMode ? renderText(out) : JSON.stringify(out, null, 2));
  } else if (command === 'service-start') {
    try {
      await request('/commands');
      const out = { started: false, alreadyRunning: true };
      console.log(textMode ? renderText(out) : JSON.stringify(out, null, 2));
      process.exit(0);
    } catch {}
    const child = spawn(process.execPath, [fileURLToPath(new URL('./index.js', import.meta.url))], { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try { await request('/commands'); ready = true; break; } catch { await new Promise(r => setTimeout(r, 100)); }
    }
    if (!ready) throw new Error('Service did not start');
    const out = { started: true, pid: child.pid };
    console.log(textMode ? renderText(out) : JSON.stringify(out, null, 2));
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
      console.log(textMode ? renderText(out) : JSON.stringify(out, null, 2));
    }
  }
} catch (e) { fail(e); }