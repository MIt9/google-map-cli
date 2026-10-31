---
name: google-maps-cli
description: Research businesses and manage leads using the local Google Maps CLI and Chrome extension.
---

# Google Maps CLI

Use `gmaps --help` and `gmaps <command> --help` to discover commands and their exact options. Run `gmaps service-start` and `gmaps status`; load the companion Chrome extension if it is not connected. Output is JSON on stdout and errors go to stderr.

Search with `gmaps search --query 'barbers in Lviv'`. Find leads using `gmaps find-leads --query dentist --areas '["Lviv"]'`, then inspect them with `gmaps leads --action list`. Use `gmaps enqueue --args '{"tool":"findLeads","args":{"query":"dentist","areas":["Lviv"]}}'` for long jobs and inspect with `gmaps queue --action list` or `--action get --id <id>`.

When Maps displays a captcha or consent page, resolve it in the browser and press Resume in the extension. Never blindly retry a queue job marked `unverified`; inspect external state first. Extraction relies on Google's changing English-language UI, and results may be incomplete. See the project README for installation and operational limits.
