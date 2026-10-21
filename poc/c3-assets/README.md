# PoC C3: Workers Free + Static Assets (без R2)

Лише синтетичні дані. Не підключено до Prom, чинних YML і таблиці. Погоджено власником 22.10.2026 (один тестовий Worker `mm-feed-poc`).

| Файл | Що робить |
|---|---|
| `src/worker.js` | Worker: перевірка ключа (SHA-256), маніфест, перевірка наявності частин, потокове склеювання частин у `FixedLengthStream`; частини напряму недоступні (`run_worker_first: true`) |
| `build.mjs` | Версія: частини ≤24 MiB + `manifest.json` (sha256, байти) + `wrangler.json`; перевірка збірки перед деплоєм; `--corrupt=missing\|size\|byte` для тестів захисту |
| `readback.mjs` | Завантаження фіду і звірка SHA-256/розміру (ключ не виводиться) |
| `run-poc.mjs` | Фази хмарного тесту: auth, deploy-a, access, load, atomic, publish (з авто-відкатом), rollback, versions, analytics |

Секрети і стан — лише в `~/.mm-feed-poc/` (поза репозиторієм): `feed-key.txt`, `cloudflare.env`, `state.json`.
Збірки (`.build-*`) і `node_modules` — у `.gitignore`. Wrangler закріплено версією в `package.json` (окремо від основного пакета, де залежностей немає).

Локально в runtime Cloudflare (`npx wrangler dev -c .build-A/wrangler.json`): 49 368 959 Б віддано цілим файлом, SHA-256 збігся; немає частини → 503; частина коротша → обрив з'єднання (клієнт бачить помилку); підмінений байт → 200, але SHA не збігається (ловить readback). Тести логіки — `test/c3-worker.test.mjs`.
