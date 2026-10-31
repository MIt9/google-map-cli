# Google Maps CLI

Local CLI, service, and Chrome extension for Google Maps lead research. The CLI and service use JSON; Chrome provides the existing Maps session. This is a separate copy from the original MCP project.

## Quick install

```sh
curl -fsSL https://raw.githubusercontent.com/MIt9/google-map-cli/refs/heads/main/install.sh | sh
```

## Install and start

Requires Node.js 20+ and Chrome. In `mcp-server/`, run `npm ci`, then `npm link`. In Chrome open `chrome://extensions`, enable Developer mode, and load the project's `extension/` directory unpacked. Run `gmaps service-start`, then `gmaps status`. The extension retries every 30 seconds; use its Reconnect button to connect immediately.

```sh
gmaps --help
gmaps search --help
gmaps search --query 'barbers in Lviv' --limit 20
gmaps find-leads --query dentist --areas '["Lviv"]'
gmaps leads --action list
gmaps queue --action list
```

Each command's `--help` works offline and lists parameters, required fields, types and limits. For example:

```sh
gmaps get-place --url 'https://www.google.com/maps/place/...' --no-activity
gmaps enqueue --tool findLeads --args '{"query":"dentist","areas":["Lviv"]}'
gmaps queue --action get --id 1
gmaps export-leads --format json
```

Arrays and objects are JSON strings; booleans accept `true`, `false`, or `--no-` for false. `--json` supplies the entire command argument object, e.g. `gmaps search --json '{"query":"dentist","limit":5}'`. The older whole-command `--args` form remains accepted. Results go to stdout as JSON; errors go to stderr with a nonzero exit status. Jobs run sequentially; `queue cancel` only cancels queued work.

The service listens only on loopback: extension WebSocket port 47832 and command API port 47833. State is under `~/.gmaps-cli`, default downloaded files and JSONL under `~/gmaps-cli-leads`. Environment variables `GMAPS_CLI_API_PORT`, `GMAPS_CLI_WS_PORT`, and `GMAPS_CLI_DIR` override service settings; the extension's port is configured in `extension/background.js`. Do not point the service at the original project's state directory. To migrate, stop the service and copy original files into a backup/new directory; never move the original state.

## Operation mapping

All original operations are represented: `status`, `search`, `get-place`, `get-reviews`, `get-photos`, `download-place`, `find-leads`, `competitors`, `place-at`, `leads`, `check-website`, `export-leads`, `snapshot`, `read-page`, `click`, `scroll`, `enqueue`, and `queue`. The low-level click and scroll commands interact with the Maps page. Existing persistent queue behavior is inherited: one worker, queued cancellation, retries for reads, and `unverified` after an interrupted click. See the original project's README for detailed fields and limitations.

## Recovery and updates

The extension halts when it detects a captcha or consent page. Resolve it in Chrome and press Resume. Queue state is persisted; a running click after a restart becomes `unverified`, so inspect the page before repeating it. Back up `~/.gmaps-cli` before an update. Run `gmaps service-stop` before replacing code, run `npm ci`, restart with `gmaps service-start`, and reload the unpacked extension. The stop command refuses to interrupt active work; queued jobs remain on disk. Extension and service versions must match.

Run `node --test` in `mcp-server/`. The tests check the help and rejection of unknown options for all 18 commands, CLI validation, status, lead listing, queuing and recovery across a stop/restart, plus the copied extraction and queue logic. They do not establish full behavioral parity: actual Google Maps interactions and each valid parameter combination require a live Chrome session and have not been verified as part of this conversion. Maps UI and selectors may change. Automated Maps access may be subject to Google's terms; use the official Places API where appropriate.
