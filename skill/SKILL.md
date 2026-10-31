---
name: google-maps-cli
description: Research businesses and manage leads using the local Google Maps CLI and Chrome extension.
---

# Google Maps CLI

Use `gmaps --help` and `gmaps <command> --help` to discover commands and their exact options. Run `gmaps service-start` and `gmaps status`; load the companion Chrome extension if it is not connected. Output is JSON on stdout and errors go to stderr. In a terminal (TTY) output is human-readable text; force with `--text` or `GMAPS_CLI_FORMAT=text`, JSON with `--json`/`GMAPS_CLI_FORMAT=json`.

Search with `gmaps search --query 'barbers in Lviv'`. Find leads using `gmaps find-leads --query dentist --areas '["Lviv"]'`, then inspect them with `gmaps leads --action list`. Use `gmaps enqueue --args '{"tool":"findLeads","args":{"query":"dentist","areas":["Lviv"]}}'` for long jobs and inspect with `gmaps queue --action list` or `--action get --id <id>`.

When Maps displays a captcha or consent page, resolve it in the browser and press Resume in the extension. Never blindly retry a queue job marked `unverified`; inspect external state first. Extraction relies on Google's changing English-language UI, and results may be incomplete. See the project README for installation and operational limits.

Diagnostics: `gmaps doctor` checks versions, port, state directory permissions, Chrome presence, service and extension connection; each failed check includes a `fix`. Configuration: `gmaps config get|set|unset port`. Extension: `gmaps extension install [--open]`, `gmaps extension path`. Update: `gmaps update --check` compares versions.

Port conflict returns `PORT_IN_USE` with the port number, owning PID and a hint. Service recognizes its own previous version via pid-file and process command line.