# Етап C2-B — читання робочої Google-таблиці через Sheets API (лише читання)

Стан: **код готовий і протестований на синтетиці (69/69); хмарних ресурсів не створено, доступів не надано, реальних даних через API не читали, push не робили.** Кожен крок нижче — окреме погодження власника.

## 1. Що робить C2-B

GitHub Actions (приватний репозиторій `TSOstap/maisternia-prom-infra`) отримує короткоживучий токен Google без JSON-ключів (Workload Identity Federation) і **читає** аркуші робочої таблиці:

| Аркуш | Навіщо (чинна бізнес-логіка) |
|---|---|
| Основний каталог | фід main (5029): синк F:M, печатки, YML |
| Нові товари | фід new92 (92): синк F:M, печатки, YML |
| Відкладені товари | відомі картки: не «нові», кандидати зіставлення (D1) |
| Заморожені ID | свідомо виключені товари: не «нові» (D1b п. 7) |
| Групи | категорії YML, groupsSha |

Не читаються: Журнал, Аудит, Налаштування (там посилання з ключем). Запис у таблицю неможливий технічно: scope `spreadsheets.readonly` + роль «Читач».

Що перевіряє `tools/sheets-verify.mjs` (усі 5121 товарів двох активних фідів):

- склад і контрольні SHA: count / idsSha / contentSha / groupsSha кожного фіду = еталон (`config/expected-live.json`: main = LIVE MTY, new92 = NEW92 Codex); печатка кожного рядка;
- ціни F:H за формулою, знижка ↔ наявність, валідність кількості, усі рядки ЗІСТАВЛЕНО, одна мітка синку;
- контент: назви й описи UA/RU, фото (1–10, URL), характеристики (JSON, ≤100), SEO-запити UA/RU (не порожні, ≤1024), група/категорія, «Статус імпорту»;
- дублікати Offer ID між аркушами і ID постачальника між картками;
- обидва YML будуються тим самим кодом, що LIVE (байт-у-байт паритет доведено раніше), перевіряються незалежним валідатором, розмір ≤ 50 млн;
- `--replay`: повний цикл нового конвеєра (зіставлення, D1, D1b, захист від дублікатів і відсутніх, публікація в тимчасове сховище runner) на цих даних із фідом постачальника, відтвореним з останньої синхронізації. Очікування на справному каталозі: синк OK, обидва фіди PUBLISHED, 0 конфліктів / зникнень / перев'язок, sourceDigest main = LIVE-збірці;
- метрики: час читання, кількість запитів Sheets API, повтори, байти, пікова пам'ять; хвилини — з даних запуску GitHub.

## 1.1 Архітектура авторизації (перевірено в документації 21.10.2026)

```
GitHub Actions (sheets-verify.yml, гілка main, workflow_dispatch)
   │  OIDC-токен GitHub (permissions: id-token: write)
   ▼
Google STS ── Workload Identity Pool «github» / Provider «maisternia-prom-infra»
   │  attribute-condition: цей репозиторій (числовий ID) + власник (числовий ID) + main + саме цей workflow
   ▼
IAM Credentials: імперсонація service account mm-sheets-reader (роль workloadIdentityUser — лише для цього репозиторію)
   │  access token: scope spreadsheets.readonly, 600 с; маскується action-ом
   ▼
Google Sheets API (values.batchGet) ── таблиця поділена з email service account як «Читач»
```

| Рішення | Чому (джерело) |
|---|---|
| Service account + імперсонація, а не «direct WIF» | Для OAuth-токена action вимагає service account; таблицю шерять на email, а federated principal email не має (google-github-actions/auth README; Workspace «create credentials») |
| `google-github-actions/auth@v3` | актуальна мажорна версія (v3, node24); маскує access_token через `setSecret` |
| `access_token_scopes: …/spreadsheets.readonly` | `cloud-platform` (типовий scope) не входить у scope batchGet; readonly унеможливлює запис |
| `access_token_lifetime: 600s` | менше за типові 3600 с; читання займає секунди |
| `create_credentials_file: false`, `export_environment_variables: false` | облікові дані не пишуться на диск і в оточення інших кроків |
| Умова на `repository_id` / `repository_owner_id` | Google вимагає attribute-condition для GitHub і радить числові ID проти cybersquatting |
| + `ref == refs/heads/main` і `workflow_ref` цього файла | на приватному GitHub Free environments/required reviewers недоступні — обмеження робимо на боці Google |
| Роль лише `roles/iam.workloadIdentityUser` на service account | містить `getAccessToken`; `serviceAccountTokenCreator` не потрібна (лише для domain-wide delegation) |
| Жодних ролей service account на проєкт | доступ — тільки шеринг таблиці «Читач» |

Умова провайдера (числові ID отримано з `gh api repos/TSOstap/maisternia-prom-infra`: repository_id 1428429135, owner_id 223876873):

```
assertion.repository_id == '1428429135' && assertion.repository_owner_id == '223876873'
  && assertion.ref == 'refs/heads/main'
  && assertion.workflow_ref == 'TSOstap/maisternia-prom-infra/.github/workflows/sheets-verify.yml@refs/heads/main'
```

Мапінг: `google.subject=assertion.sub, attribute.repository_id=assertion.repository_id, attribute.repository_owner_id=assertion.repository_owner_id, attribute.ref=assertion.ref, attribute.workflow_ref=assertion.workflow_ref`. Issuer: `https://token.actions.githubusercontent.com` (README action; у прикладах Google — з кінцевим `/`, розбіжність не з'ясована — перевірити на кроці 4). Коли пізніше додасться розкладний `update.yml`, умову розширюємо окремим погодженням.

## 1.2 Покрокове налаштування (кожен крок — окремо, після підтвердження попереднього)

| # | Хто | Дія | Перевірка |
|---|---|---|---|
| 1 | власник | ✅ **21.10.2026:** проєкт створено без білінгу й без пробного періоду. Project ID `maisternia-prom-infra`, Project number `679502453033`, Organization: No organization | ID і номер проєкту |
| 2 | власник | ✅ **21.10.2026:** увімкнено 5 API (IAM, Cloud Resource Manager, IAM Service Account Credentials, Security Token Service, Google Sheets) — **білінг не знадобився**, пробний період не активовано | ризик «verify that billing is enabled» на цьому кроці не підтвердився |
| 3 | власник | ✅ **21.10.2026:** service account `mm-sheets-reader@maisternia-prom-infra.iam.gserviceaccount.com` — Enabled, No keys, без ролей і доступів | email підтверджено |
| 4 | власник | ✅ **21.10.2026 (Cloud Shell, `tools/gcp/c2b-step4-wif.sh`):** пул `github`, провайдер `maisternia-prom-infra` (ACTIVE, issuer `https://token.actions.githubusercontent.com`, умова: repository_id 1428429135 + owner 223876873 + refs/heads/main + workflow sheets-verify.yml); на SA одна роль `roles/iam.workloadIdentityUser` для `principalSet://…/attribute.repository_id/1428429135`; ключів 0; білінг не знадобився | `projects/679502453033/locations/global/workloadIdentityPools/github/providers/maisternia-prom-infra` |
| 5 | власник | Поділитися робочою таблицею з email service account як **«Читач»** (без сповіщення) | у «Налаштуваннях доступу» таблиці — лише Читач |
| 6 | Claude | Змінні репозиторію `GCP_WIF_PROVIDER`, `GCP_SA_EMAIL`, секрет `MM_SHEET_ID` (через `gh`; значення ID таблиці вводить власник або передає приватно) | `gh variable list` / `gh secret list` |
| 7 | Claude | За дозволом: push коду, один ручний запуск `sheets-verify` | усі перевірки PASS, лог без товарних даних |

Видалення всього (відкат): прибрати шеринг «Читач» у таблиці → видалити провайдер і пул → видалити service account → видалити проєкт. Чинна система від цього не залежить.

## 2. Обробка даних (п. 8 вимог)

- У логи, Job Summary і код виходу потрапляють **лише агрегати**: кількості, булеві збіги хешів, байти, час. Offer ID і тексти товарів редагуються (тест `google-sheets.test.mjs` це перевіряє).
- Artifacts не завантажуються. YML і тимчасове сховище — у тимчасовому каталозі runner, видаляються в кінці; runner GitHub знищується після job.
- ID таблиці — у GitHub Secret `MM_SHEET_ID`. Токен Google не друкується (маскується GitHub Actions); живе ≤ 10 хв.
- Репозиторій лишається приватним; перед кожним push — `tools/prepush-check.mjs` (шаблони токенів Google, JSON-ключів, посилань на таблицю).

## 3. Квоти і вартість (п. 10)

| Ресурс | Очікування на один запуск | Ліміт | Примітка |
|---|---|---|---|
| Sheets API read | ≈15–20 запитів (1 metadata + ~13 порцій main по 400 рядків + 1–2 для решти аркушів) | 60/хв на користувача, 300/хв на проєкт | у коді: темп ≤50/хв, жорстка межа 60 запитів на запуск, backoff на 429 |
| Обсяг відповіді | ≈50–70 МБ JSON | без жорсткого ліміту, рекомендовано невеликі порції | порція ≈4 МБ |
| GitHub Actions | 1 job ≈1–2 хв (оцінка; буде виміряно) | 2000 хв/міс | timeout 10 хв |
| Google Cloud | проєкт без білінг-акаунта | — | будь-яка вимога увімкнути білінг = STOP |

## 4. DONE для C2-B

- [ ] проєкт Google Cloud без білінгу; увімкнені лише потрібні API;
- [ ] Workload Identity Federation з умовою на `repository_id`/`repository_owner_id` (і гілку main); жодного JSON-ключа;
- [ ] service account має доступ «Читач» лише до цієї таблиці; жодних ролей проєкту, крім потрібних для федерації;
- [ ] `sheets-verify` на runner: усі перевірки PASS для 5121 товарів, replay PASS;
- [ ] у логах/summary немає товарних даних і секретів (перевірено переглядом логу);
- [ ] виміряно: час читання, запити, пам'ять, хвилини; COSTS.md оновлено;
- [ ] чинна система не змінювалась: Apps Script, тригери, YML-посилання, Prom.

## 5. STOP-умови

- Google вимагає білінг-акаунт для будь-якої дії → зупинка й питання власнику.
- Будь-яке значення хешу не збігається з еталоном → не «підганяти»: звіт власнику (можливо, каталог змінили погоджено — тоді оновити еталон окремим комітом після підтвердження).
- 429/квота під час читання → не збільшувати темп; зупинка й аналіз.
- Будь-яка ознака, що токен або товарні дані потрапили в лог → видалити запуск (логи) і переглянути крок.
