<!-- autopilot:start -->
# Sextant — десктоп-клиент Kubernetes (Rust/Tauri 2 + React/TS, аналог Lens) для разработчиков и SRE

## Команды

Перед всем: `export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"`. Всё ниже запускать из корня репозитория.

- Установка: `npm ci`
- Всё сразу (CI делает то же): `npm run check` — fmt, clippy `-D warnings`, `scripts/check-core-deps.mjs`, тесты Rust, сверка TS-типов, tsc (+ `e2e/`), eslint, vitest. Зелёный: Rust 195, vitest 283.
- Запуск: `npm run tauri dev` (Vite на 1420, `strictPort`)
- Установщики: `npm run tauri build`; бинарь без бандла: `npm run tauri -- build --debug --no-bundle` → `target/debug/sextant`
- Один тест: `cargo test -p sextant-core <имя>` · `npx vitest run <файл>`
- Перегенерировать TS-типы из Rust: `npm run gen:types`
- Тестовый кластер (kind `sextant-test`, нужны `kind`, `kubectl`, docker): `scripts/test-cluster.sh up` (`up --prometheus` — ещё Prometheus в `monitoring`), `scripts/test-cluster.sh kubeconfig` (путь, по умолчанию `~/.cache/sextant-test/kubeconfig`), `scripts/test-cluster.sh down`
- Интеграционные тесты ядра против кластера: `SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) cargo test -p sextant-core --tests -- --test-threads=1`
- E2E (WebdriverIO + tauri-driver, нужны `tauri-driver` и `webkit2gtk-driver`, кластер с `--prometheus`): `SEXTANT_E2E_SKIP_BUILD=1 npm run e2e` → 13 passing; без переменной сам собирает debug-бинарь. Скриншоты падений — `target/e2e/`.

## Где что

- Архитектура, поток данных, границы модулей, реестры, соглашения: `docs/architecture.md`
- Решения и их причины: `docs/adr/` (0001–0012); словарь предметной области: `CONTEXT.md`
- Ядро (kubeconfig, watch, действия, логи, exec, port-forward, метрики, Helm, настройки): `crates/sextant-core/src/`; его интеграционные тесты: `crates/sextant-core/tests/<feature>.rs` + `tests/common/mod.rs`
- Tauri-слой: команды `src-tauri/src/commands/<feature>.rs`, регистрация всех команд — `src-tauri/src/lib.rs` (`with_commands`), состояние и закрытие подписок — `src-tauri/src/state.rs`, PTY — `src-tauri/src/pty.rs`; тест на каждую команду — `src-tauri/tests/commands.rs`
- Фронтенд-мост к backend: `src/api/` (`commands.ts`, `events.ts`, `stream.ts`, `mockBackend.ts`); типы — `src/api/generated/`
- Фичи: `src/features/<name>/index.ts` (подхватываются сами, `src/app/features.ts`); таблицы и виды ресурсов — `src/resources/`; оболочка и реестры страниц/дока/деталей — `src/layout/`; UI-состояние — `src/app/store.ts`
- Строки интерфейса: `src/locales/en/<namespace>.json`; тестовый кластер и фикстуры: `scripts/`; E2E: `e2e/`; CI: `.github/workflows/ci.yml`, `release.yml`

## Подводные камни

- `target/` раздувается до десятков ГБ (при проверке — 35 ГБ) из-за отладочной информации; для локальных сборок и проверок: `CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 npm run check`.
- Интеграционные тесты без `SEXTANT_TEST_KUBECONFIG` молча пропускаются и считаются пройденными (в stderr только «skipped»); зелёный `cargo test --workspace` без кластера ничего не доказывает про кластер. Тесты с остановкой контейнера kind (`connect.rs`, `watch.rs`) — только при `SEXTANT_TEST_DOCKER_RESTART=1`.
- `src/api/generated/` руками не править: `npm run check` сверяет его с тем, что генерирует Rust. Тип стал пересекать границу — `serde(rename_all = "camelCase")` + `ts-rs`, затем `npm run gen:types` и коммит результата.
- Имена команд и событий в генерацию не входят: добавляя команду, правь вручную `src-tauri/src/lib.rs` (`generate_handler!`), `src/api/commands.ts` и `src-tauri/tests/commands.rs`; опечатка видна только в тесте или в рантайме.
- Литералы строк в JSX запрещены eslint (`i18next/no-literal-string`); строка идёт через `src/locales/en/<ns>.json`, значение поля собирается вне JSX. `@tauri-apps/*` вне `src/api/` тоже запрещён eslint.
- `sextant-core` не должен тянуть `tauri` и `portable-pty`: процессы ОС (`helm`) — за фичей `desktop`; нарушение ловит `node scripts/check-core-deps.mjs`.
- Стримы: фронтенд вешает `listen` после `*_start`, поэтому backend придерживает ранний вывод: watch — батчи по 250 мс, логи — первая пачка через 300 мс (`LISTENER_GRACE`), терминал — до первого `term_resize`/`term_input`. Новый стрим без такой задержки и теста теряет вывод.
- Новая подписка, стрим или сессия должна жить в `AppState` (`src-tauri/src/state.rs`), иначе `close_cluster` и закрытие окна её не закроют.
- Фича подключается только через `src/features/<name>/index.ts` (`import.meta.glob`); каталог без `index.ts` в приложение не попадёт.
- `settings_update` не перезаписывает то, что пишет backend (`kubeconfigSources`, размеры окна): новое backend-поле нужно добавить в `update_settings` (`src-tauri/src/commands/settings.rs`).
- Все ошибки kube — через `error::kube_error` (вырезает секреты exec-плагина); `helm` запускать только через `HelmCli::command()` (чистит `HELM_KUBE*` и `KUBECONFIG`); настоящий helm в `src-tauri/tests/commands.rs` не запускается.
- E2E: `e2e/wdio.conf.ts` зашивает порт tauri-driver 4444, native-port не задан (по умолчанию 4445); если порты заняты или совпали, driver падает при старте — помогает `tauri-driver --port 4447 --native-port 4448` (в конфиге сейчас не прописано).
- E2E: WebKitWebDriver теряет повторы и пробелы в `browser.keys` (для текста есть `typeText` в `e2e/app.ts`) и неверно печатает `/` и `:` — такие символы через `browser.keys` не вводить.
- TypeScript закреплён на `~6.0` (ограничение typescript-eslint) — не обновлять вслепую.
- CI (`ci.yml`) срабатывает на push и PR в ветку `main`, три ОС, `core.autocrlf false`; по записям сборки ни разу не запускался на GitHub.
- macOS и Windows здесь не проверить — только CI. Что ломалось там и не видно на Linux: имена файлов, различающиеся только регистром (ловит `scripts/check-case-collisions.mjs`), GNU-only утилиты в тестовых скриптах (`stat -c`), `/proc`, `Path::is_absolute` по правилам хоста, путь `tauri://localhost` в тестах IPC (на Windows — `http://tauri.localhost`), хэши путей с `/`.
- Релиз: тег `v*` или ручной запуск `gh workflow run release.yml -f tag=vX.Y.Z` (пересобрать существующий тег без его переписывания).

## Окружение

Значения нигде не хранятся; `.env.example` — лишь список имён, `.env` ничем не подгружается.

- `SEXTANT_TEST_KUBECONFIG` — путь к admin-kubeconfig тестового кластера; включает интеграционные тесты (`crates/sextant-core/tests`, `src-tauri/src/state.rs`) и e2e
- `SEXTANT_TEST_KUBECONFIG_LIMITED` — kubeconfig ServiceAccount `limited` (без доступа к Secret); по умолчанию `kubeconfig-limited` рядом с admin
- `SEXTANT_TEST_DIR` — каталог файлов тестового кластера (по умолчанию `~/.cache/sextant-test`)
- `SEXTANT_TEST_DOCKER_RESTART` — разрешает тестам останавливать и запускать контейнер kind
- `SEXTANT_E2E_SKIP_BUILD` — e2e использует готовый `target/debug/sextant`
- `SEXTANT_BINDINGS_OUT`, `SEXTANT_BINDINGS_COMMITTED` — каталоги для `scripts/bindings.mjs` (где ts-rs пишет / где лежит закоммиченное); по умолчанию `target/ts-bindings` и `src/api/generated`
- `KUBECONFIG` — приложение читает его как источник kubeconfig; в e2e указывает только на тестовый кластер
- `SHELL` — оболочка локального терминала (Unix), иначе `/bin/sh`
- `TAURI_DEV_HOST` — хост dev-сервера Vite для запуска на мобильных устройствах
- `CARGO_PROFILE_DEV_DEBUG`, `CARGO_INCREMENTAL` — отключают отладочную информацию и инкрементальную сборку, чтобы `target/` не разрастался
- `METRICS_SERVER_URL` — откуда `scripts/test-cluster.sh` берёт манифест metrics-server

## Как здесь работает Autopilot

Сборка ведётся навыком `/autopilot`. Требования, спецификация и таски — в `.autopilot/`.
Прогресс — `.autopilot/dashboard.html`. Требование из `manifest.md` может снять
только пользователь. Прерванную сборку продолжает «продолжи автопилот».

### Правка без автопилота

Мелкий баг или доводка после сборки — обычная сессия, без прогона.

Сначала прочитай:
1. `.autopilot/PROGRESS.md` — что не доделано, известные баги, о чём договорились с пользователем.
2. Что правили после последней сборки — первая строка таблицы в «История git».
3. Только если правка их касается: почему сделано так — `docs/adr/`; что значат слова — `CONTEXT.md`;
   что именно просили — `manifest.md` в папке сборки (указана в начале `PROGRESS.md`).

После правки:
- коммит — по правилам из «История git»;
- строка в «Правки без автопилота» в `PROGRESS.md`: дата — что — почему;
- починенный пункт из «Не доделано» или «Известные баги» — удали;
- договорились с пользователем о том, что следующая сборка не должна пересматривать, —
  строка в «Договорились», его словами.

### История git

Целиком не читай — бери срез под вопрос:

| Вопрос | Команда |
|---|---|
| что правили после последней сборки | `git log --oneline "$(git log -1 --format=%h --grep='^Autopilot: сборка сдана')"..HEAD -- . ':(exclude).autopilot'` |
| всё, что делали ради требования | `git log --oneline --grep="R02"` |
| история файла | `git log --oneline -10 -- <файл>` |
| когда появился или исчез код | `git log --oneline -S "<фрагмент>"` |
| почему строка такая | `git blame -L <с>,<по> <файл>`, затем `git show <sha>` |
| что внутри коммита | `git show --stat <sha>` |

Срез длиннее ~30 коммитов — отдай его субагенту и возьми выжимку в десять строк.

Коммит: заголовок — что (`fix: даты в одном формате`), тело — почему, трейлер
`--trailer "Requirements: R02"`, если правка касается требования из `manifest.md`.
Заголовок `Autopilot: сборка сдана` пишет только автопилот — по нему находят последнюю сборку.
<!-- autopilot:end -->
