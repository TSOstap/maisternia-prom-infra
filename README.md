# Майстерня Маркет — нова інфраструктура (прототип)

Масштабоване оновлення цін і наявності, формування та публікація YML для Prom.ua: GitHub Actions + Node.js → Cloudflare R2 → Worker.
**Shadow-режим:** робочий магазин, таблиця, Apps Script і Prom не змінюються.

```
npm test                                   # 88 тестів, включно з паритетом проти живого Apps Script
node tools/scale-test.mjs                  # 5k/10k/30k синтетичних товарів: час, пам'ять, розмір
node tools/cost-model.mjs                  # прогноз безплатних квот
node tools/synth.mjs --products=500 --new=5 --out=.data/demo
node src/cli.mjs update --store=.data/store --catalog=.data/demo/catalog --supplier=.data/demo/supplier.xml --manifest=.data/demo/approved-main.json --min-offers=10
node src/cli.mjs status --store=.data/store
node tools/prepush-check.mjs              # обов'язково перед будь-яким push
```

Документи: [RULES](RULES.md) · [C2C-PLAN](C2C-PLAN.md) · [DATA-CLEANUP-PROPOSAL](DATA-CLEANUP-PROPOSAL.md) · [C2B-REPORT](C2B-REPORT-20261021.md) · [C2B-PLAN](C2B-PLAN.md) · [C1-PLAN](C1-PLAN.md) · [DATA-AUDIT-20261021](DATA-AUDIT-20261021.md) · [ARCHITECTURE](ARCHITECTURE.md) · [BUSINESS-RULES](BUSINESS-RULES.md) · [COSTS](COSTS.md) · [TESTS](TESTS.md) · [CONNECT-PLAN](CONNECT-PLAN.md) · [PROGRESS](PROGRESS.md) · [HANDOFF](HANDOFF.md)

Вимоги: Node ≥22, без npm-залежностей.
