const TOOL_NAMES = {
  search: 'Search', getPlace: 'Place', getReviews: 'Reviews', getPhotos: 'Photos', getCompetitors: 'Competitors', getPoint: 'Point', clickPoi: 'Place at point',
  readPage: 'Read page', snapshot: 'Snapshot', click: 'Click', scroll: 'Scroll',
};

const $ = (id) => document.getElementById(id);

const fmtTime = (ms) => new Date(ms).toLocaleString([], {
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
});

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text; // textContent: history holds page text, never render as HTML
  return e;
}

function render({ connected = false, connectedChangedAt, history = [], halted, serverVersion }) {
  const extVersion = chrome.runtime.getManifest().version;
  const mismatch = connected && serverVersion && serverVersion !== extVersion;
  $('versions').textContent = `extension ${extVersion} · server ${connected ? serverVersion || '?' : '—'}`
    + (mismatch ? ' · MISMATCH: reload the extension or update the service' : '');
  $('versions').className = mismatch ? 'error' : '';
  $('halted').hidden = !halted;
  $('haltedText').textContent = halted ? `Halted: ${halted.reason}. Solve it in the Maps tab, then Resume.` : '';

  $('dot').className = `dot${connected ? ' on' : ''}`;
  $('statusText').textContent = connected ? 'Connected to CLI service' : 'Not connected';
  $('statusHint').textContent = connected
    ? `since ${fmtTime(connectedChangedAt)}`
    : 'Start the CLI service (ws://127.0.0.1:47832). Retries every 30 s.';
  $('reconnect').hidden = connected;

  const list = $('history');
  list.replaceChildren();
  if (!history.length) return list.append(el('li', 'empty', 'No actions yet'));

  for (const h of history) {
    const li = el('li');
    const top = el('div', 'top');
    top.append(
      el('span', h.status === 'ok' ? 'ok' : h.status === 'running' ? 'running' : 'error-icon'),
      el('span', 'tool', TOOL_NAMES[h.tool] || h.tool),
      el('span', 'time', fmtTime(h.startedAt)),
    );
    li.append(top);
    if (h.summary) li.append(el('div', 'summary', h.summary));
    if (h.result) li.append(el('div', 'result', `→ ${h.result}`));
    if (h.error) li.append(el('div', 'error', h.error));
    list.append(li);
  }
}

const refresh = async () => render(await chrome.storage.local.get(
  ['connected', 'connectedChangedAt', 'history', 'halted', 'serverVersion'],
));

chrome.storage.onChanged.addListener(refresh);
$('clear').onclick = () => chrome.storage.local.set({ history: [] });
$('resume').onclick = () => chrome.storage.local.remove('halted');
$('reconnect').onclick = () => chrome.runtime.sendMessage('reconnect').catch(() => {});

chrome.storage.local.get('cliPort').then(({ cliPort }) => {
  $('port').value = cliPort || 47832;
});
$('savePort').onclick = async () => {
  const port = Number($('port').value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) { alert('Port must be 1-65535'); return; }
  await chrome.storage.local.set({ cliPort: port });
};

refresh();
