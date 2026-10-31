# COMMANDS — відповідність операцій CLI

Таблиця цільової відповідності. Джерело істини — реєстр в `mcp-server/index.js` (`/commands`), довідка `gmaps <command> --help`. Автоматичний тест перевіряє, що для кожної команди й кожного прапорця є опис.

## Життєвий цикл і діагностика

| Команда | Параметри | Результат |
|---|---|---|
| `gmaps service-start` | — | `{ started, pid }` або `{ started: false, alreadyRunning: true }` |
| `gmaps service-stop` | — | `{ stopped: true }` або 409 при активній роботі |
| `gmaps doctor` | — | `{ ok, checks: [{ check, ok, fix }] }`, код 1 при невдачі |
| `gmaps config get\|set\|unset` | `port [value]` | `{ port }` |
| `gmaps extension install` | `--open` | `{ installed, path, version, id, steps }` |
| `gmaps extension path` | — | `{ path }` |

## Операції (18)

`status`, `search`, `get-place`, `get-reviews`, `get-photos`, `download-place`, `find-leads`, `competitors`, `place-at`, `leads`, `check-website`, `export-leads`, `snapshot`, `read-page`, `click`, `scroll`, `enqueue`, `queue`.

Кожна команда має `--help` з повним списком прапорців, типів, меж і описів; `--json <object>` передає всі аргументи одним об'єктом; `--args` лишається для сумісності з `enqueue`.

## Формат виводу

- Порядок: `--text` → `GMAPS_CLI_FORMAT` → TTY → текст, інакше JSON.
- Помилки: у терміналі `Error: …` (+ `Hint:` за наявності), у пайпі — JSON у stderr, код виходу однаковий.