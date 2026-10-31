---
name: google-maps-cli-usage
description: How to drive the `gmaps` CLI (local service + Chrome extension) to research businesses, generate leads, download place data, and manage leads — as a user of the finished tool, not a developer of it. Use whenever asked to search Google Maps, find leads, get place details/reviews/photos, check websites, export leads, run queue jobs, or to diagnose why the gmaps CLI or its extension does not work.
---

# Google Maps CLI usage

CLI's `--help` is the source of truth; this skill only mirrors it. Verify every flag against `gmaps <command> --help` before use.

## Before working
- Run `gmaps service-start`, then `gmaps status` (versions must match; extension connected).
- Run `gmaps doctor` if anything fails; each failed check has a `fix`.
- If halted (captcha/consent): solve in Chrome, press Resume in extension, then continue.

## Output format for the agent
- No TTY in the agent shell → JSON on stdout; errors are JSON on stderr with nonzero exit code.
- Force text with `--text` or `GMAPS_CLI_FORMAT=text`.

## Safety rules for actions
- Preview first: run without `--confirm` where applicable, show preview, get explicit user "yes" for that item, then `--confirm`.
- Never confirm on the agent's own; never batch invisible actions.
- `RATE_LIMIT`: wait, do not loop.
- `HALT`: stop; only the user resumes.
- `unverified`: do not retry; inspect external state first.

## Typical scenarios
- Search: `gmaps search --query 'barbers in Lviv' --limit 20`
- Leads: `gmaps find-leads --query dentist --areas '["Lviv"]'`
- Place: `gmaps get-place --url 'https://www.google.com/maps/place/...'`
- Queue long job: `gmaps enqueue --tool findLeads --args '{"query":"dentist","areas":["Lviv"]}'`, inspect with `gmaps queue --action list` / `get --id <id>`.
- Leads management: `gmaps leads --action list`, `gmaps export-leads --format csv`.

## Limits / not verified live
- Extraction depends on Google's changing English-language UI; results may be incomplete.
- Actual Maps interactions require a live Chrome session and have not been fully verified.
- Automated Maps access may be subject to Google's terms; prefer official Places API where appropriate.