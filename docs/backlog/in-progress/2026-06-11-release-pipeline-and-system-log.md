---
title: Release-пайплайн (GitHub Releases, авто-флот) + системный лог с ротацией
description: «Сделал релиз — весь флот сам подхватил»: publish через GitHub Releases без своего бэкенда, самолечение кривого бандла, чистая установка для клиентов; плюс внутренний системный лог (уровни, ротация, события update/sessions) для прод-дебага
type: task
status: in-progress
created: 2026-06-11
updated: 2026-07-14
related: docs/backlog/planned/2026-06-09-ccmux-v1-polish.md
---

## Цель

2 сервера + N клиентов. Целевой флоу: `ccmux release --publish` → ВСЕ машины
подхватывают сами за ≤ updateCheckInterval. Без своего эндпоинта — чисто GitHub Releases.
И чтобы на серверах был читаемый системный лог: что демон видел/делал (апдейты, хилы,
сессии), с ротацией и настраиваемым уровнем.

## Решения (выбраны 2026-06-11)

- **Раздача: GitHub Releases** (`/releases/latest/download/release.json`) — anonymous
  HTTPS, CDN, иммутабельные версии, pre-release не попадает в latest (бета-канал бесплатно).
  Отклонено: raw/jsDelivr (кэш 5м–12ч, рассинхрон манифест↔бандл), свой бэкенд (не нужен).
- **Манифест указывает на ВЕРСИОННЫЙ url бандла** (`releases/download/vX.Y.Z/ccmux.js`) —
  пара манифест+бандл атомарна, latest-гонки невозможны.
- **Самолечение кривого релиза, 2 слоя**: (1) preflight до свапа — `bun candidate.js
  version` обязан выйти 0 с верной версией (ловит load/syntax-смерть); (2) boot-guard —
  счётчик стартов демона: 3 старта подряд без успешного ensure-тика → вернуть `.bak`,
  громко в лог, exit → boot-юнит поднимает старый бандл.
- **Лог**: уровни debug|info|warn|error, дефолт info, `logLevel` в machine.json
  (live re-read). Ротация по размеру 5MB × 3 файла — фикс, не конфиг (разумно и хватит).
  События: daemon up/stop · heal started X · session new/rm/start/stop/restart/adopt ·
  update seen/preflight/applied/failed/rolled-back · boot-guard revert.
- **Клиентская установка**: `install.sh` ассетом релиза —
  `curl -fsSL .../releases/latest/download/install.sh | bash`: ставит bun при отсутствии,
  качает бандл+sha-verify, шим в `~/.local/bin/ccmux`, `ccmux install` с releaseUrl+autoUpdate.

## План

- [x] log.ts: уровни + setLogLevel + ротация 5MB×3; `logLevel` в MachineConfigSchema (`schema.ts`, демон re-read live `daemon.ts`)
- [x] Событийные логи: heal (`ensure.ts`), session new/start/stop/rm (`new/lifecycle/rm`), update seen/applied/failed/rolled-back (`update.ts`)
- [x] update.ts: `preflightBundle()` — `bun candidate version`==manifest.version ДО свапа, иначе ABORT + rm tmp
- [x] bootGuard (`util/bootGuard.ts`): счётчик `~/.ccmux/boot-attempts`, 3 старта без good-тика → .bak-revert + exit≠0; интеграция в `daemon.ts` (start + clear после первого ensure)
- [x] release как **dev-скрипт** (`scripts/release.ts` + package.json `stage`/`release`/`release:publish`), НЕ команда тулзы — `ccmux release`/`build` удалены из cli.ts/help, файлы `commands/{build,release}.ts` снесены → код физически НЕ в клиентском бандле (cli.ts их не импортит). `--publish`: repo через `gh repo view`, draft → 3 ассета → `--draft=false`; манифест url на версионный ассет; повтор версии отказывает
- [x] install: `--release-url URL` → releaseUrl + autoUpdate=true в scaffolded machine.json
- [x] scripts/install.sh (bun-bootstrap + sha256-verify + шим + `ccmux install --release-url`)
- [x] Тесты: log (уровни/ротация/cap), bootGuard (4 кейса), preflight (3 кейса) — +тесты на manifest схему уже были (ReleaseSchema)
- [x] help.ts: release/install сигнатуры; architecture-док раздел «Раздача на флот» + «Системный лог»

## Acceptance

- [x] `ccmux release --publish` создаёт релиз на GitHub одним заходом — реализовано (draft→assets→publish, repo-резолв ✅, локальный build + help проверены; сам publish НЕ запускал — outward-facing, под гейтом владельца)
- [x] Машина с releaseUrl + autoUpdate подхватывает версию — **live e2e в песочнице (изолир. HOME, file:// релиз)**: 0.0.7→0.0.8 swap, .bak сохранён
- [x] Кривой бандл НЕ свапается / крашлуп → .bak — preflight-abort проверен live (live untouched при mismatch версии И sha256); boot-guard revert покрыт юнитами (4 кейса); rollback проверен live (0.0.8→0.0.7)
- [x] Свежая машина одной curl-командой — `scripts/install.sh` написан; реальный прогон возможен только после первого `--publish` (latest-ассеты), т.е. при первом релизе на сервера
- [x] Лог: апдейт seen/applied/failed/rolled-back и session-события пишутся (проверено в e2e-выводе); ротация 5MB×3 + cap (юнит-тест); уровень из machine.json live (debug в e2e-конфиге дал debug-строки)

## Что НЕ доделано (осознанно, вынесено)

- ~~Реальный `--publish` первого релиза + curl-install на серверы~~ → **сделано**: серверный
  роллаут состоялся, авто-апдейты живут (0.1.5→0.1.6→0.1.7 подхвачены всем флотом без рук,
  видно в логах демонов: `auto-update seen`).
- `restart`/`adopt` событийные логи — низкий приоритет, restart и так логирует wake-note; добавим если понадобится в дебаге.

---

# Ревизия 2026-07-14: коммит ↔ релиз (идеальный пайплайн v2)

## Проблема (вскрылась на живом релизе v0.1.7)

Раздача/самолечение/лог (скоуп выше) работают. Но **паблиш отвязан от git**:
`release:publish` собирает бандл из ЛОКАЛЬНОГО рабочего дерева (хоть грязного) и заливает
ассеты; `gh release create` вешает тег на удалённый HEAD — который может вообще не
содержать этот код. Реальный результат: тег `v0.1.7` указывает на `fc23cd9` (за 2 дня и
22 файла до фактического кода релиза). Отсюда:

1. **История лжёт**: `git diff v0.1.6..v0.1.7` не показывает, что вошло в релиз.
2. **Нет гейта**: можно опубликовать, не прогнав `bun run check` (тесты+tsc).
3. **Недетерминизм**: бандл = «что сейчас на маке у Макса», не воспроизводимо из тега.
4. **Локальная зависимость**: паблиш требует залогиненного `gh` на конкретной машине.

## Инварианты идеального пайплайна

1. **Тег ↔ код**: релизный тег стоит ровно на том коммите, из которого собраны ассеты.
   «Что вошло» = `git diff vA..vB`, всегда честно.
2. **Не каждый коммит = релиз**: коммиты накапливаются свободно (ревью-буфер Макса);
   релиз = осознанная точка — бамп версии + тег. Жёсткая связь в одну сторону.
3. **Гейт механизмом, не дисциплиной**: красный `bun run check` → релиза физически нет.
4. **Один путь публикации**: только CI по тегу. Локального `--publish` не существует
   (никаких «можно и так и так»).
5. **Чистая сборка**: бандл собирается в CI из свежего checkout тега,
   `bun install --frozen-lockfile`.
6. Атомарность манифест↔бандл (версионный asset-url) и самолечение флота
   (preflight + boot-guard) — уже живут, не трогаем.

## Целевой флоу

```
работа → коммиты (ревью Макса, как сейчас)
   ↓ «релиз»
bun run release 0.1.8 "notes"     # ЛОКАЛЬНО только git-церемония:
   • отказ при грязном дереве
   • быстрый прегейт: bun run check
   • бамп package.json → коммит "0.1.8: notes" → тег v0.1.8 → push main + тег
   ↓ (тег прилетел)
GitHub Actions release.yml (on: push tag v*):
   • checkout тега; guard: тег == package.json version, иначе fail
   • bun install --frozen-lockfile → bun run check   ← ГЕЙТ
   • build бандла → sha256 → манифест (версионный url)
   • gh release: draft → 3 ассета → publish (атомарно для флота)
   • release notes: сообщение бамп-коммита + git log vPrev..vNew --oneline
   ↓
флот: releaseUrl тот же → демоны сами подхватывают ≤300с (ничего не меняется)
```

- `scripts/release.ts`: остаются `--stage` (локальный тест бандла через `ccmux update`)
  и `local` (file://-релиз для песочных e2e — им пользуются acceptance-прогоны);
  **`--publish` выпиливается целиком**.
- Токен: стандартный `GITHUB_TOKEN` Actions (релиз в свой же репо) — ноль секретов/конфига.
- Опционально: protection на теги `v*` (пушит только владелец).

## Ремедиация v0.1.7

Ассеты канонны, флот на них — не трогаем. После коммита текущего дерева передвинуть тег
`v0.1.7` на этот коммит (`git tag -f v0.1.7 && git push -f origin v0.1.7` — только тег,
ассеты нетронуты) → история становится честной задним числом. По явной команде владельца.

## Сверка с внешним референсом (зрелый npm-пакет с CI-релизами; 2026-07-14)

Референсный проект уже живёт по целевым инвариантам — подтверждает дизайн и даёт
паттерны лучше первоначальных:

| Паттерн референса | Вердикт для ccmux |
|---|---|
| **Один `ci.yml` на всё**: job `ci` (lint/typecheck/test/build) на КАЖДЫЙ push/PR; job `release` — только на тег `v*`, `needs: [ci, smoke]` | **Перенять, это лучше** моего release-only workflow: у ccmux сейчас CI нет вообще — каждый push должен гоняться, релиз лишь переиспользует зелёный гейт |
| Guard «тег == package.json version» в release-job | Совпадает с планом v2 ✓ |
| **Runtime-smoke отдельным job** (node-smoke: built dist + реальный HTTP round-trip под рантаймом потребителя) | **Перенять адаптированно**: CI-smoke built-бандла — `bun ccmux.js version` == тег (+ `list --json` на пустом реестре). Это CI-двойник нашего fleet-preflight: кривой бандл валится ДО публикации, а не на машинах |
| **CHANGELOG.md** с `[Unreleased]` → release-notes извлекаются awk'ом из секции версии | **Перенять**: курируемый changelog честнее моего «бамп-коммит + git log --oneline» |
| **Git-хуки** `.githooks` + `core.hooksPath` через `prepare`: pre-commit (формат+строгий lint), pre-push (полный `verify` = то, что гоняет CI) — «broken push never turns CI red» | **Перенять облегчённо**: pre-push = `bun run check`. Biome у ccmux нет — вводить можно позже, отдельно (не смешивать с пайплайном) |
| npm OIDC trusted publishing (ноль хранимых токенов) | Аналог у нас уже в плане: `GITHUB_TOKEN` Actions (релиз в свой же репо) — тот же ноль секретов |
| Релиз-церемония = 3 ручных шага (bump → changelog → tag+push) | **У нас лучше**: `bun run release X.Y.Z "notes"` автоматизирует церемонию одной командой (меньше ручных ошибок) |
| — (дистрибуции нет, её делает npm) | **У нас лучше/уникально**: версионный asset-url + sha256 + fleet-самолечение (preflight/boot-guard/rollback) — оставляем как есть |

## План v2 (уточнён по сверке)

- [x] `.github/workflows/ci.yml` — ОДИН workflow: job `ci` (frozen install → `bun run check`)
      на каждый push/PR; job `smoke` (build бандла → `bun ccmux.js version` + `list --json`);
      job `release` on tag `v*`, `needs: [ci, smoke]` → guard tag==pkg.version → build →
      sha256 → манифест → draft→publish (3 ассета) → notes из CHANGELOG-секции
- [x] `CHANGELOG.md` с `[Unreleased]`-дисциплиной (ретро-секции v0.1.0…v0.1.7 по датам
      реальных коммитов)
- [x] `scripts/release.ts`: `--publish` удалён; git-церемония = дефолтный режим
      (`bun run release X.Y.Z "notes"`: guards грязное-дерево/не-main/существующий-тег →
      прегейт check → бамп → CHANGELOG-ролл → commit → tag → push); `--ci-assets URL`
      для CI; `--stage`/`--local` остались
- [x] `.githooks/pre-push` = `bun run check` + `core.hooksPath` через `prepare`
- [x] README «Updates»+«Build & release» / architecture-док «Раздача на флот»: новый флоу,
      инварианты
- [x] Локальная верификация: гварды отказывают вживую (грязное дерево, даунгрейд версии,
      без аргументов), CI-smoke шаги прогнаны против собранного бандла (version==pkg,
      `list --json` shape), YAML workflow отлинтован, весь сьют 88 pass + tsc чистый
- [x] Первый CI-релиз — v0.1.8 (2026-07-14 ~14:05 +08:00): церемония → тег → CI
      (ci+smoke+release зелёные) → атомарный publish `GITHUB_TOKEN`'ом; sha256 манифеста
      сошёлся с ассетом; `git diff v0.1.7..v0.1.8` = ровно вошедшее; флот сам подхватил
      за ~4 мин, сессии пережили bounce. «Гейт валит красное» доказано вживую первым же
      прогоном: сломанный smoke (без стаб-конфига) → release-job skipped
- [x] Ремедиация тега v0.1.7: передвинут на честный коммит (`a9c0044`), ассеты нетронуты;
      в release-job добавлен graceful-skip существующих релизов (ре-пуш тега безопасен)

## Acceptance v2

- [x] Релиз невозможен из грязного дерева и без зелёного check — оба отказа проверены:
      dirty-tree refusal вживую (церемония отказала с листингом), красный гейт — первый
      CI-прогон (упавший smoke заблокировал release-job)
- [x] `git diff vA..vB` показывает ровно вошедшее в релиз — проверено на v0.1.7..v0.1.8
- [x] Паблиш работает с любой машины без локального gh — v0.1.8 опубликован целиком в CI
- [x] Флот подхватывает CI-релиз так же, как локальные — все машины на 0.1.8 за ~4 мин,
      sha256 сошёлся, сессии целы
