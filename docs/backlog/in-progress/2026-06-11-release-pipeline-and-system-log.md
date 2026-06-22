---
title: Release-пайплайн (GitHub Releases, авто-флот) + системный лог с ротацией
description: «Сделал релиз — весь флот сам подхватил»: publish через GitHub Releases без своего бэкенда, самолечение кривого бандла, чистая установка для клиентов; плюс внутренний системный лог (уровни, ротация, события update/sessions) для прод-дебага
type: task
status: in-progress
created: 2026-06-11
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

- Реальный `--publish` первого релиза + curl-install на серверы + смотр их логов → **это и есть серверный роллаут**, под явным «го» владельца (см. `planned/…server-rollout.md`). Код готов и проверен в песочнице.
- `restart`/`adopt` событийные логи — низкий приоритет, restart и так логирует wake-note; добавим если понадобится в дебаге.
