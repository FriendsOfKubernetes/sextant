<!-- autopilot:start -->
# Sextant — десктоп-клиент Kubernetes (Rust/Tauri 2 + React/TS, аналог Lens) для разработчиков и SRE

## Команды

Перед всем: `export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"`. Всё ниже запускать из корня репозитория.

- Установка: `npm ci`
- Всё сразу (CI делает то же): `npm run check` — сверка имён файлов по регистру, `check:version`, fmt, clippy `-D warnings`, `scripts/check-core-deps.mjs`, тесты Rust, сверка TS-типов, tsc (+ `e2e/`), eslint, vitest. Зелёный: Rust 339, vitest 471.
- Запуск: `npm run tauri dev` (Vite на 1420, `strictPort`)
- Установщики: `npm run tauri build` — нужен ключ подписи обновлений (см. «Подводные камни»); без ключа: `npm run tauri build -- --config '{"bundle":{"createUpdaterArtifacts":false}}'`. Бинарь без бандла: `npm run tauri -- build --debug --no-bundle` → `target/debug/sextant`
- Версия во всех манифестах: `npm run check:version`; совпадение с тегом релиза: `node scripts/check-version.mjs --tag vX.Y.Z`
- Один тест: `cargo test -p sextant-core <имя>` · `npx vitest run <файл>`
- Перегенерировать TS-типы из Rust: `npm run gen:types`
- Тестовый кластер (kind `sextant-test`, нужны `kind`, `kubectl`, docker): `scripts/test-cluster.sh up` (`up --prometheus` — ещё Prometheus в `monitoring`; `up --gitops` — ещё Flux v2.9.6 (`flux-system`) и Argo CD v3.5.5 (`argocd`) из официальных манифестов и фикстуры `scripts/fixtures/gitops/`; флаги сочетаются), `scripts/test-cluster.sh kubeconfig` (путь, по умолчанию `~/.cache/sextant-test/kubeconfig`), `scripts/test-cluster.sh down`
- Нагрузочная фикстура (150 CRD и 500 подов в неймспейсе `sextant-load`; нужна тесту `the_first_nodes_come_within_2_seconds_on_a_big_cluster`, без неё он пропускается): `scripts/fixtures/load/load.sh apply`, после замера `scripts/fixtures/load/load.sh delete`
- Интеграционные тесты ядра против кластера: `SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) cargo test -p sextant-core --tests -- --test-threads=1` → 203 passed
- Интеграционные тесты GitOps (`crates/sextant-core/tests/gitops*.rs`) нужны `SEXTANT_TEST_GITOPS=1` и кластер, поднятый с `--gitops`: `SEXTANT_TEST_GITOPS=1 SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) cargo test -p sextant-core --test gitops --test gitops_flux --test gitops_argocd --test gitops_argocd_diff -- --test-threads=1`; без `SEXTANT_TEST_GITOPS=1` они пропускаются (и считаются пройденными)
- E2E (WebdriverIO + tauri-driver, нужны `tauri-driver` и `webkit2gtk-driver`, кластер с `--prometheus`): `SEXTANT_E2E_SKIP_BUILD=1 npm run e2e` → 13 passing; без переменной сам собирает debug-бинарь. Скриншоты падений — `target/e2e/`.

## Где что

- Архитектура, поток данных, границы модулей, реестры, соглашения: `docs/architecture.md`
- Решения и их причины: `docs/adr/` (0001–0032; 0013–0023 — решения сборки 0.2.0, 0024–0032 — GitOps: Flux и Argo CD); словарь предметной области: `CONTEXT.md`
- Ядро (kubeconfig, discovery, watch, действия, логи, exec, port-forward, метрики, Helm, настройки): `crates/sextant-core/src/`; его интеграционные тесты: `crates/sextant-core/tests/<feature>.rs` + `crates/sextant-core/tests/common/mod.rs` (там же помощники GitOps: `GITOPS_ENV`, `gitops_cluster`, `connected`, `wait_until`); юнит-тесты ядра без кластера ходят в поддельный API-сервер `crates/sextant-core/src/fake_api.rs` (`#[cfg(test)]`: `FakeApi::start(|req| Reply…)`, `connected_to(url)`)
- Argo CD (вход и дифф): ядро — `crates/sextant-core/src/argocd.rs` (`ArgoClient`, поиск установки, учётные данные), команды `argocd_status`/`argocd_login`/`argocd_logout`/`argocd_diff` — `src-tauri/src/commands/argocd.rs`, сессии — `ArgoSessions` (там же), поле `AppState.argocd` в `src-tauri/src/state.rs`
- Tauri-слой: команды `src-tauri/src/commands/<feature>.rs`, регистрация всех команд и плагинов (в т.ч. updater) — `src-tauri/src/lib.rs`, состояние и закрытие подписок — `src-tauri/src/state.rs`, PTY — `src-tauri/src/pty.rs`, окно и выход — `src-tauri/src/window.rs`, права плагинов — `src-tauri/capabilities/`; тест на каждую команду — `src-tauri/tests/commands.rs`
- Фронтенд-мост к backend: `src/api/` (`commands.ts`, `events.ts`, `stream.ts`, `transport.ts`, `updater.ts`, `mockBackend.ts`); типы — `src/api/generated/`
- Фичи: `src/features/<name>/index.ts` (подхватываются сами, `src/app/features.ts`); обновления приложения — `src/features/updates/` (проверка при старте, раздел Settings); таблицы и виды ресурсов — `src/resources/`; оболочка и реестры страниц/дока/деталей — `src/layout/`; UI-состояние — `src/app/store.ts`
- GitOps на фронтенде: Flux — `src/features/flux/`, Argo CD (виды, детали, действия, «Open Argo CD UI») — `src/features/argocd/`, вход и дифф — `src/features/argocd/diff/`, подключаемые отдельной фичей `src/features/argocd-diff/` (регистрирует действие `argoDiff`)
- Общие компоненты без знания о Kubernetes (`Checkbox`, `LoadingIndicator`, `Dialog`, `ConfirmDialog`, `ErrorState`, `Badge`, `Age`, `usePopup`) — `src/components/` (импорт из `src/components/index.ts`); таблица ресурсов — `src/components/Table/`
- Строки интерфейса: `src/locales/en/<namespace>.json`; тестовый кластер и фикстуры: `scripts/`; E2E: `e2e/`; CI: `.github/workflows/ci.yml`, `release.yml`

## Подводные камни

- `target/` раздувается до десятков ГБ (при проверке — 35 ГБ) из-за отладочной информации; для локальных сборок и проверок: `CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 npm run check`.
- Интеграционные тесты без `SEXTANT_TEST_KUBECONFIG` молча пропускаются и считаются пройденными (в stderr только «skipped»); зелёный `cargo test --workspace` без кластера ничего не доказывает про кластер. Тесты с остановкой контейнера kind (`connect.rs`, `watch.rs`) — только при `SEXTANT_TEST_DOCKER_RESTART=1`.
- Крейт `sextant` встраивает собранный фронтенд из `dist/`: на чистом клоне перед `npm run check` нужен `npm run build` (CI делает так же).
- `src/api/generated/` руками не править: `npm run check` сверяет его с тем, что генерирует Rust. Тип стал пересекать границу — `serde(rename_all = "camelCase")` + `ts-rs`, затем `npm run gen:types` и коммит результата.
- Имена команд и событий в генерацию не входят: добавляя команду, правь вручную `src-tauri/src/lib.rs` (`generate_handler!`), `src/api/commands.ts` и `src-tauri/tests/commands.rs`; опечатка видна только в тесте или в рантайме.
- Литералы строк в JSX запрещены eslint (`i18next/no-literal-string`); строка идёт через `src/locales/en/<ns>.json`, значение поля собирается вне JSX. `@tauri-apps/*` вне `src/api/` тоже запрещён eslint (плагины — через `transport.ts`).
- `sextant-core` не должен тянуть `tauri` и `portable-pty`: процессы ОС (`helm`) — за фичей `desktop`; нарушение ловит `node scripts/check-core-deps.mjs`.
- Стримы (watch, логи, терминал): id создаёт фронтенд, `openStream` (`src/api/stream.ts`) вешает `listen("<префикс>:<id>")` до `*_start(…, streamId)`, поэтому backend ничего не придерживает: первый снапшот watch уходит сразу, дальше пачки не чаще 250 мс (`BATCH_INTERVAL`), логи — 100 мс. Не добавляй задержек и не запускай стрим мимо `openStream`. id — `[A-Za-z0-9_-]`, ≤128, занятый или неверный — `invalid` (`check_stream_id`). Страница при загрузке один раз вызывает `streams_reset` (`resetStreams()`), старт, переживший сброс, отклоняется (`AppState::undo_if_reset`); команда `*_start` регистрирует подписку в `AppState` до работы ядра (`start_watch`), иначе остановка во время старта её не прервёт.
- Новая подписка, стрим или сессия должна жить в `AppState` (`src-tauri/src/state.rs`), иначе `close_cluster` и закрытие окна её не закроют.
- Значения Secret вырезаются в ядре (`resources::get::to_json`: значения `""`, аннотация `sextant.dev/values-hidden`, без last-applied), поэтому их нет ни в watch, ни в `resource_get`. Полное значение — только `secret_value` (один ключ) и `resource_get_full` (для редактора). `resource_replace`/`resource_apply` отвергают объект с аннотацией-маркером (`ensure_values_present` в `Document::from_value`) — не убирай этот вызов при правке `mutate.rs`.
- Discovery одна на кластер (`ClusterManager::kinds`, общий результат для всех ждущих); `ResourceKind.printerColumns` из неё всегда пуст — колонки CRD читаются лениво одним CRD (`useCrdPrinterColumns` в `src/resources/crdColumns.ts`). Встроенные виды (`BUILT_IN_KINDS` в `crates/sextant-core/src/resources/get.rs`) открываются без discovery. CRD в сайдбаре берутся из discovery: новый CRD виден после переподключения.
- `WatchSpec.metadata_only` (TS `metadataOnly`) отдаёт только `{apiVersion, kind, metadata}`; для списков, которым нужны одни метаданные (релизы Helm), а не целые объекты.
- Время ожидания: подключение — 10 с на соединение и 20 с на проверку; изменения под `CHANGE_TIMEOUT` = 30 с на запрос (`src-tauri/src/commands/actions.rs`: scale, restart, cordon, trigger, suspend, replace, delete); drain и apply нескольких документов — по 30 с на каждый запрос (`resources::STEP_TIMEOUT`), без лимита на всю операцию. `timeout` не отменяет операцию на сервере. Клиент сам повторяет 429/503/504 не более 3 раз и не дольше 5 с (`cluster::RetryPolicy`; kube-овский `server_retry` выключен) и только запросы с клонируемым телом.
- `settings_update` не перезаписывает то, что пишет backend (`kubeconfigSources`, размеры окна): новое backend-поле нужно добавить в `update_settings` (`src-tauri/src/commands/settings.rs`). Нечитаемый `settings.json` не перезаписывается (копия `.bak-…`, `settings_status`).
- Все ошибки kube — через `error::kube_error` (вырезает секреты exec-плагина); `helm` запускать только через `HelmCli::command()` (чистит `HELM_KUBE*` и `KUBECONFIG`); настоящий helm в `src-tauri/tests/commands.rs` не запускается.
- Временный kubeconfig терминала живёт в `TermSession.guard` и удаляется синхронно при остановке сессии; файлы `sextant-kubeconfig-*` после падения чистятся при старте (`remove_stale_temp_kubeconfigs`), каталоги `sextant-shell-*` — нет.
- Фича подключается только через `src/features/<name>/index.ts` (`import.meta.glob`); каталог без `index.ts` в приложение не попадёт. Нативных чекбоксов нет: используй `Checkbox` из `src/components`.
- Версия приложения записана в пяти местах (`Cargo.toml` `[workspace.package]`, `Cargo.lock`, `src-tauri/tauri.conf.json`, `package.json`, `package-lock.json`) и должна совпадать с тегом релиза; поднимай все сразу и проверяй `npm run check:version`.
- Обновления: `bundle.createUpdaterArtifacts` включено в `src-tauri/tauri.conf.json`, поэтому релизная сборка подписывает артефакты ключом из `TAURI_SIGNING_PRIVATE_KEY` (+ `_PASSWORD`) и без него падает; локально — сборка с `--config` из «Команд». Публичный ключ — `plugins.updater.pubkey` в `tauri.conf.json`: без ключа или endpoint плагин не регистрируется (`updater_configured` в `src-tauri/src/lib.rs`, то же правило — `updaterConfiguredIn` в `src/api/updater.ts`), а интерфейс показывает обновления выключенными. Потеря приватного ключа — установленные копии не примут обновлений (ADR-0022).
- GitOps (Flux, Argo CD) работает только через Kubernetes API: действия — `resource_patch` (`api.resources.patch`, `PatchType` merge/json), ни `flux`/`argocd` CLI, ни установки из утилиты (ADR-0024, ADR-0025). Патч, называющий `sextant.dev/values-hidden`, — `invalid`.
- Новый CRD (в т.ч. поставленный Flux/Argo уже после подключения) виден без переподключения: `watchCrdChanges` (`src/resources/useKinds.ts`, metadata-watch на CRD, антидребезг `CRD_REFRESH_DELAY` = 1 с) зовёт `cluster_kinds_refresh` (`ClusterManager::refresh_kinds`), сбрасывающую кэш discovery (ADR-0026). Не возвращай «только после переподключения».
- Разделы Flux и Argo CD — это виды реестра в секциях `flux`/`argocd` (`SidebarSection` в `src/resources/registry.ts`, ADR-0031); без видов в discovery раздел скрыт. Страницы `registerPage` в этих секциях discovery не проверяет: страницу регистрируй только со своей проверкой наличия инструмента (`useClusterKinds` + `findKind`).
- `resolve_kind` (`crates/sextant-core/src/resources/get.rs`): запрошенная версия вида, если discovery её даёт, иначе версия из discovery (discovery хранит одну, предпочтительную) — это для get/watch/patch по `ObjectRef`; `replace_yaml`/`apply_yaml` идут в версии из документа (`resolve_document_kind`), если группа её обслуживает, иначе `notFound` без запроса (ADR-0030).
- Вход в Argo CD — только через `ArgoSessions` (`AppState.argocd`): API Argo доступен через port-forward к `argocd-server`, TLS не проверяется только для `127.0.0.1` (ADR-0027); порядок источников — сохранённое, `argocd-initial-admin-secret`, Secret с меткой `app.kubernetes.io/part-of=argocd` и ключом `token`, иначе `unauthorized` (ADR-0028). Пароли и токены Argo никогда не уходят во фронтенд (`SecretString` печатается `<hidden>`, в `ManagedResource` значения Secret вырезаны) и не логируются.
- Сохранённый вход Argo — keyring ОС: сервис `sextant`, пользователь `argocd:<clusterId>:<ns>`, значение JSON `{username,password}` или `{token}` (ADR-0029). Кандидат, отвергнутый Argo CD, не пробуется снова, пока не изменится его источник (resourceVersion секрета, новое сохранение, новый ввод; `is_refusal`, `standard_credentials_with_origin`); недоступность сервера не запоминается.
- Сервер Argo CD ищется только в неймспейсе установки; установку определяют ClusterRoleBinding `argocd-application-controller`/`argocd-server` (имя привязки и имя SA, в т.ч. `<release>-…` Helm), без него (namespaced-установка, нет прав на CRB) — кандидаты по `argocd-cm`/`argocd-initial-admin-secret`; неоднозначность — `notFound` с префиксом `argocd::AMBIGUOUS_INSTALLATION`, фронтенд ничего не открывает (ADR-0032). `argocdNamespace` во фронтенде — `api.argocd.status().namespace`.
- `TypeScript` закреплён на `~6.0` (ограничение typescript-eslint) — не обновлять вслепую.
- E2E: `e2e/wdio.conf.ts` зашивает порт tauri-driver 4444, native-port не задан (по умолчанию 4445); если порты заняты или совпали, driver падает при старте — помогает `tauri-driver --port 4447 --native-port 4448` (в конфиге сейчас не прописано).
- E2E: WebKitWebDriver теряет повторы и пробелы в `browser.keys` (для текста есть `typeText` в `e2e/app.ts`) и неверно печатает `/` и `:` — такие символы через `browser.keys` не вводить.
- CI (`ci.yml`) срабатывает на push и PR в ветку `main` и вручную, на ubuntu, macOS и Windows, `core.autocrlf false`. macOS и Windows здесь не проверить — только CI. Что ломалось там и не видно на Linux: имена файлов, различающиеся только регистром (ловит `scripts/check-case-collisions.mjs`), GNU-only утилиты в тестовых скриптах (`stat -c`), `/proc`, `Path::is_absolute` по правилам хоста, путь `tauri://localhost` в тестах IPC (на Windows — `http://tauri.localhost`), хэши путей с `/`.
- Релиз: тег `v*` или ручной запуск `gh workflow run release.yml -f tag=vX.Y.Z` (пересобрать существующий тег без его переписывания). `release.yml` сверяет тег с версией, собирает .deb/.AppImage, универсальный .dmg и .msi, собирает `latest.json` и публикует релиз только если в нём есть все платформы; установщики не подписаны сертификатами ОС.

## Окружение

Значения нигде не хранятся; `.env.example` — лишь список имён, `.env` ничем не подгружается.

- `SEXTANT_TEST_KUBECONFIG` — путь к admin-kubeconfig тестового кластера; включает интеграционные тесты (`crates/sextant-core/tests`, `src-tauri/src/state.rs`) и e2e
- `SEXTANT_TEST_KUBECONFIG_LIMITED` — kubeconfig ServiceAccount `limited` (без доступа к Secret); по умолчанию `kubeconfig-limited` рядом с admin
- `SEXTANT_TEST_DIR` — каталог файлов тестового кластера (по умолчанию `~/.cache/sextant-test`)
- `SEXTANT_TEST_DOCKER_RESTART` — разрешает тестам останавливать и запускать контейнер kind
- `SEXTANT_TEST_GITOPS` — `1` включает интеграционные тесты GitOps (Flux и Argo CD; кластер `scripts/test-cluster.sh up --gitops`); без неё они пропускаются
- `SEXTANT_E2E_SKIP_BUILD` — e2e использует готовый `target/debug/sextant`
- `SEXTANT_BINDINGS_OUT`, `SEXTANT_BINDINGS_COMMITTED` — каталоги для `scripts/bindings.mjs` (где ts-rs пишет / где лежит закоммиченное); по умолчанию `target/ts-bindings` и `src/api/generated`
- `KUBECONFIG` — приложение читает его как источник kubeconfig; в e2e указывает только на тестовый кластер
- `SHELL` — оболочка локального терминала (Unix), иначе `/bin/sh`
- `TAURI_DEV_HOST` — хост dev-сервера Vite для запуска на мобильных устройствах
- `CARGO_PROFILE_DEV_DEBUG`, `CARGO_INCREMENTAL` — отключают отладочную информацию и инкрементальную сборку, чтобы `target/` не разрастался
- `METRICS_SERVER_URL` — откуда `scripts/test-cluster.sh` берёт манифест metrics-server
- `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — секреты репозитория GitHub (только в GitHub Actions, `release.yml`): ключ подписи обновлений и его пароль; локально и в `.env.example` их нет

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
