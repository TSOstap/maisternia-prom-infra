# C3: публікація YML через нову інфраструктуру — архітектура (проєкт)

Стан: **лише проєкт, 22.10.2026.** Жодних ресурсів Cloudflare чи інших сервісів не створено, нічого не запущено. Чинні YML, Apps Script, mtUpdate і Prom не змінюються.

Позначки: **ОК** — є в офіційній документації; **НЕ ЗНАЙДЕНО** — в офіційних джерелах не знайдено; **НЕОДНОЗНАЧНО** — джерела суперечать або сформульовано нечітко; **(розрахунок)** — мій розрахунок. Сторінки читалися через інструмент, що переказує текст, тому ключові цитати варто звірити на першоджерелі перед рішенням.

## 1. Вимоги власника

| # | Вимога | Як перевіряємо варіант |
|---|---|---|
| 1 | 0 грн/міс | безплатний план вистачає з запасом (розрахунок нижче) |
| 2 | бажано без банківської картки | офіційна документація плану |
| 3 | без ризику непередбачених списань | що відбувається при перевищенні: помилка/зупинка чи рахунок |
| 4 | стабільна публічна HTTPS-адреса | домен за замовчуванням або власний |
| 5 | великі файли: основний YML ≈49 МБ, далі більше | ліміт одного файлу |
| 6 | оновлення кожні 4 год | ліміти деплоїв/записів |
| 7 | сумісність із Prom | пряма віддача файлу, без сторінок-попереджень |
| 8 | захист від публікації пошкодженого фіду | перевірка до перемикання, атомарне перемикання |
| 9 | зберігати попередню справну версію | версії / відкат |
| 10 | мінімальне обслуговування | без серверів, без ручних кроків у штатному режимі |

## 2. Порівняння варіантів

| Варіант | Картка | Списання при перевищенні | Файл 49 МБ | Версії / відкат | Комерційне використання | Вердикт |
|---|---|---|---|---|---|---|
| **A. Workers Free + Static Assets, фід частинами ≤24 MiB, Worker віддає як один файл** | НЕ ЗНАЙДЕНО в офіційних джерелах (Workers уже працюють в акаунті власника: `deploy`, `feed-filter-test`) | Free: при перевищенні — помилка 1027 / 429, «further operations … will fail with an error» (ОК). Окремого речення «списань немає» НЕ ЗНАЙДЕНО | asset ≤25 MiB (ОК) → 49 МБ = 2 частини | версія Worker = код + assets; деплой перемикає версію; `wrangler rollback`, 100 останніх версій (ОК) | заборони не знайдено; `workers.dev` — «intended for personal or hobby projects», для продакшну радять route/custom domain (ОК) | **рекомендовано як основний — після безплатного PoC** |
| B. Як A, але один gzip-файл ≈8–10 МБ | як A | як A | так, один asset | як A | як A | запасний: потрібне підтвердження, що Prom приймає gzip **за посиланням** (НЕОДНОЗНАЧНО) |
| C. R2 + Worker | офіційно «checkout flow» для R2-підписки; за Cloudflare Community — картка (НЕОДНОЗНАЧНО) | жорсткого ліміту витрат НЕ ЗНАЙДЕНО; Community: «usage is not capped» | 5 GiB за PUT (ОК) | атомарний перезапис, strong consistency, CopyObject (ОК) | заборони не знайдено | технічно найзручніший, але **порушує вимоги 2–3**; лише за окремим рішенням власника |
| D. Firebase Hosting (Spark) | «No payment information needed» (ОК) | жорстка зупинка: сайт вимикається до кінця місяця (ОК) | 2 GB на файл (ОК) | версії, релізи, відкат (ОК) | прямої заборони не знайдено | запасний; трафік НЕОДНОЗНАЧНО: 10 GB/міс чи 360 MB/добу. 49 МБ × ~6 завантажень/добу ≈ 294 МБ/добу (розрахунок) — на межі, при перевищенні фід **зникає** |
| E. GitHub Releases | не потрібна | обмежень не заявлено, AUP при «excessive» | 2 GiB (ОК) | заміна asset неатомарна (видалити → завантажити) | для Releases заборони не знайдено | не підходить: потрібен **публічний** репозиторій, неатомарне оновлення |
| F. GitHub Pages | — | — | 100 MiB у репозиторії | — | **заборонено**: «not … allowed to be used … to run your online business, e-commerce site» (ОК); на Free — лише публічний репозиторій | не підходить |
| G. Cloudflare Pages | НЕ ЗНАЙДЕНО | статика безлімітна | **25 MiB на файл** (ОК) | є | як A | не підходить для 49 МБ; для gzip — гірше за B (Cloudflare радить нові проєкти робити на Workers) |
| H. Netlify Free | без картки (ОК) | пауза, без списань (ОК) | файли >10 MB «not well-supported» (ОК) | атомарні деплої | AUP: не як «remote storage server» | не підходить: 180 деплоїв/міс × 15 credits = 2700 при ліміті 300 (розрахунок) |
| I. Backblaze B2 | для публічного bucket — картка або платіж (ОК) | «unlimited charges can accrue» без caps (ОК) | так | вручну | — | не підходить |
| J. Google Drive / Apps Script | — | — | Drive: попередження антивіруса для великих файлів (лише вторинні джерела); UrlFetch 50 MB | — | — | не підходить (це і є поточне обмеження ~50 МБ) |

Джерела (офіційні):
- Workers: <https://developers.cloudflare.com/workers/platform/limits/>, <https://developers.cloudflare.com/workers/platform/pricing/>, <https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/>, <https://developers.cloudflare.com/workers/static-assets/binding/>, <https://developers.cloudflare.com/workers/runtime-apis/streams/>, <https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/>, <https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/>, <https://developers.cloudflare.com/workers/configuration/routing/workers-dev/>, <https://developers.cloudflare.com/speed/optimization/content/compression/>
- R2: <https://developers.cloudflare.com/r2/get-started/>, <https://developers.cloudflare.com/r2/pricing/>, <https://developers.cloudflare.com/r2/platform/limits/>, <https://developers.cloudflare.com/r2/reference/consistency/>; вторинне — <https://community.cloudflare.com/t/why-using-r2-free-tier-involves-giving-card-info/945179>
- Cloudflare Pages: <https://developers.cloudflare.com/pages/platform/limits/>
- GitHub: <https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits>, <https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features>, <https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases>, <https://docs.github.com/en/rest/releases/assets>
- Firebase: <https://firebase.google.com/docs/hosting/usage-quotas-pricing>, <https://firebase.google.com/pricing>, <https://firebase.google.com/docs/projects/billing/firebase-pricing-plans>, <https://firebase.google.com/docs/hosting/manage-hosting-resources>
- Netlify: <https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/>, <https://docs.netlify.com/build/configure-builds/troubleshooting-tips/>
- Backblaze: <https://www.backblaze.com/docs/cloud-storage-create-and-manage-buckets>, <https://www.backblaze.com/docs/cloud-storage-data-caps-and-alerts>
- Apps Script: <https://developers.google.com/apps-script/guides/services/quotas>
- Prom: <https://support.prom.ua/hc/uk/articles/360004963478>, <https://support.prom.ua/hc/uk/articles/16093369524509> (читалися через Zendesk API, бо сайт віддає 403 звичайному запиту)

### Факти про Workers Static Assets, на яких тримається варіант A

| Факт | Статус |
|---|---|
| Розмір одного asset — 25 MiB (Free і Paid) | ОК |
| До 20 000 файлів на версію (Free) | ОК |
| «Requests to static assets are free and unlimited»; запити, що виконують Worker, рахуються в 100 000/добу | ОК |
| `assets.run_worker_first` (true або масив шляхів) — Worker виконується перед віддачею asset; при перевищенні Free-ліміту такі запити отримують 429 | ОК |
| `env.ASSETS.fetch()` — Worker може отримати asset зі своєї версії | ОК |
| Чи рахується `env.ASSETS.fetch()` у ліміт 50 subrequests | НЕ ЗНАЙДЕНО (для 2–12 частин некритично) |
| CPU 10 мс: очікування мережі не рахується; чи рахується передача потоку (pipe) тіла | НЕОДНОЗНАЧНО → **головне питання PoC** |
| Денного ліміту деплоїв не знайдено; деплой можливий з 100 останніх версій; відкат — до 100 останніх | ОК / НЕ ЗНАЙДЕНО (денний ліміт) |
| Загальний обсяг assets на версію | НЕ ЗНАЙДЕНО |
| Cloudflare сам стискає відповідь (gzip/brotli) для клієнта з `Accept-Encoding`, `text/xml` у списку | ОК — зменшує трафік, але не знімає ліміт 25 MiB на asset |
| Картка для Workers Free | НЕ ЗНАЙДЕНО в офіційних джерелах |

## 3. Рекомендована архітектура C3 (варіант A)

```
GitHub Actions (приватний репозиторій, cron кожні 4 год поза вікном mtUpdate :10–:35 UTC)
  1. читання таблиці (Sheets API, WIF, readonly) + фід постачальника      ← вже працює (C2-B, C2-C)
  2. конвеєр: mtMatch → mtPrices → mtPlan → D1/D1b → генерація YML           ← вже є, паритет із LIVE
  3. ПЕРЕВІРКИ ДО ПУБЛІКАЦІЇ (будь-яка FAIL → стоп, стара версія лишається):
       XML валідний; кількість offer = паспорту; печатки/маніфест; розмір у межах;
       поріг аномалії (масові зникнення/конфлікти); SHA-256 файлу
  4. розбиття main.yml на частини ≤24 MiB + manifest.json {sha256, bytes, parts[]}
  5. wrangler versions upload      → нова версія Worker (ще не активна)
  6. wrangler versions deploy 100% → атомарне перемикання на нову версію
  7. readback: завантажити фід за публічною адресою, звірити SHA-256 і розмір з manifest
       не збіглося → wrangler rollback (попередня справна версія) + повідомлення
Cloudflare Worker (Free, run_worker_first: true)
  GET /feeds/<секретний-токен>/main.xml → перевірка токена → потік: частина 1 → 2 → … (env.ASSETS.fetch)
  Content-Type: application/xml; charset=utf-8; Content-Length = сума частин
  будь-який інший шлях → 404 (частини напряму недоступні)
Prom.ua — імпорт за посиланням (як зараз, лише інша адреса; перемикання — окремий етап C5 за погодженням)
```

Чому так:
- **Без R2** — немає білінгу R2 і питання з карткою для R2 (вимоги 2–3). Сховище = версії Worker.
- **Атомарність** — деплой посилається на одну версію. Prom отримує або повністю стару, або повністю нову версію, ніколи не суміш частин (частини входять у ту саму версію).
- **Попередня справна версія** — це попередня версія Worker. Відкат однією командою, глибина — 100 версій ≈ 16 днів при 6 деплоях/добу (розрахунок).
- **Пошкоджений фід не публікується** — перевірки (п. 3) виконуються до завантаження. Після перемикання — readback і автоматичний відкат.
- **Обслуговування** — серверів немає. Штатно ручних кроків немає. Секрети: токен Cloudflare API (лише права на Workers Scripts цього акаунта) і токен доступу до фіду — у GitHub Secrets.
- **Worker не рахує SHA на запит** (10 мс CPU). SHA рахує Actions до завантаження і під час readback.

Квоти (розрахунок для 49 МБ, 2 фіди, 6 оновлень/добу): запити до Worker — Prom і readback ≈ 20–50/добу при ліміті 100 000; деплої 180/міс; GitHub Actions — як у C2-C (один job), у межах безплатних хвилин приватного репозиторію (COSTS.md).

### Запасні варіанти (у порядку переваги)

1. **B — один gzip-asset** (якщо PoC покаже, що потік частин перевищує CPU-ліміт). Умова: Prom має прийняти `.gz` за посиланням. Офіційно Prom пише про ZIP/GZIP для імпорту файлу, для способу «Посилання» — НЕОДНОЗНАЧНО. Перевірити можна лише тестовим імпортом у Prom — це окреме погодження.
2. **D — Firebase Hosting Spark** (без картки, жорстка зупинка, версії). Лише з gzip і лише після з'ясування чинного ліміту трафіку. Ризик — сайт вимикається до кінця місяця при перевищенні.
3. **C — R2 + Worker** — лише якщо власник свідомо погодиться на картку і моніторинг витрат (бюджетні сповіщення Cloudflare — сповіщення, не жорсткий ліміт).

## 4. Масштабування без зміни товарів і структури фіду

| Товарів | YML, МБ (розрахунок, COSTS.md) | Частин по 24 MiB | Що робити |
|---|---|---|---|
| 5 121 (зараз) | 49,9 | 2 | нічого |
| 10 000 | 97,5 | 4 | нічого |
| ≈18 000 | ≈175 | 7 | межа рекомендації Prom «до 180 МБ» на файл |
| 30 000 | 292,5 | 12 | розділити на 2 фіди за групами (Prom: до 4 посилань, імпорт по черзі) |

- До ~170 МБ структура фіду і посилання Prom не змінюються, росте лише кількість частин усередині версії.
- Понад ~170 МБ потрібне розділення за групами на 2–4 посилання. Це зміна налаштування імпорту в Prom — **лише за окремим погодженням**, без зміни товарів, ID і вмісту.
- Пам'ять Worker (128 MB) не обмежує: частини передаються потоком, без буферизації.
- Ліміт 20 000 файлів на версію не досяжний (до 12 частин + кілька службових файлів).

## 5. Ризики і що перевіряє PoC

| Ризик | Перевірка |
|---|---|
| CPU 10 мс при потоковій передачі 2–12 частин | PoC: синтетичний фід 60 МБ і 300 МБ, 20 завантажень, журнал CPU-часу Worker |
| ліміт subrequests для `ASSETS.fetch` | PoC: 12 частин в одному запиті |
| невідомий денний ліміт деплоїв | PoC: 7 деплоїв поспіль за годину |
| `workers.dev` — «для особистих/хобі-проєктів» | рішення власника: лишити `workers.dev` чи підключити власний домен (якщо домен є в Cloudflare) |
| Prom і довга потокова відповідь без кешу | на етапі C4 (тестове посилання для Prom), не в PoC |
| картка для Workers Free | власник перевіряє в дашборді (Billing), нічого не змінюючи |

## 6. Етапи (кожен — після окремого погодження)

1. **C3-0 PoC, лише синтетика.** Тестовий Worker з назвою на кшталт `mm-feed-poc` в акаунті власника. Синтетичні дані з генератора, без реальних товарів. Без Prom. Видаляється після тесту. Потрібно від власника: погодити створення Worker, створити API-токен з мінімальними правами (ручний крок).
2. **C3-1 код публікатора** (локально, з тестами): розбиття, manifest, upload/deploy/readback/rollback.
3. **C3-2 shadow-публікація реального фіду** за секретною адресою, не підключеною до Prom. Порівняння байт-у-байт із чинним YML.
4. **C4 розклад** кожні 4 год (shadow).
5. **C5 перемикання Prom** на нову адресу — окреме рішення власника.

## 7. Що потрібно погодити до наступного етапу

1. Вибір варіанта A як основного (B, D, C — запасні).
2. Створення одного тестового Worker для PoC на синтетиці (C3-0) і видалення його після тесту.
3. Ручний крок власника: API-токен Cloudflare з мінімальними правами → GitHub Secret (я дам точну інструкцію, один крок за раз).
4. Чи перевіряти gzip-імпорт у Prom (варіант B) — окремо і пізніше.
5. Домен: `workers.dev` чи власний.
