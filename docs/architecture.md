# Архитектура Sextant

Три слоя, зависимости только сверху вниз: `src/` (React) → `src-tauri/` (крейт `sextant`) → `crates/sextant-core/`.
Почему так решено — `docs/adr/`; значение слов — `CONTEXT.md`.

## Поток данных

```
kubeconfig ──► KubeconfigRegistry ──► ClusterManager ──► kube::Client (повторы, таймауты)
                                          │                  │
                           ConnectionState (broadcast)       ├─ resources::watch  ─► Stream<WatchUpdate>   (пачки ≤ 1 в 250 мс)
                                          │                  ├─ logs::stream_logs ─► Stream<LogUpdate>     (пачки 100 мс)
                                          │                  ├─ exec::exec_shell  ─► ExecSession
                                          │                  ├─ PortForwarder     ─► broadcast<Vec<ForwardInfo>>
                                          ▼                  └─ get / mutate / metrics / helm (запрос-ответ)
                        src-tauri: команды (invoke) и события (emit)
                                          │
                        src/api: invoke / listen / openStream (transport.ts), mockBackend для тестов
                                          │
                        хуки (useWatch, useClusters, …) ─► zustand store + реестры ─► компоненты
```

- Запрос-ответ: компонент → `api.<группа>.<метод>` → `invoke("<command>")` → тонкая команда в `src-tauri/src/commands/<feature>.rs` → функция ядра → `Result<T, CoreError>`.
- Живые данные (watch, логи, терминал): id потока создаёт фронтенд (`newStreamId()`), `openStream` (`src/api/stream.ts`) вешает `listen("<префикс>:<id>")` и только потом вызывает `*_start(…, streamId)`; backend пересылает поток ядра событиями `watch:<id>`, `logs:<id>`, `term:<id>`. Порядок id → listen → start → unlisten → stop держит один `openStream`. Закрытие в любой точке ничего не оставляет: старт, ещё не ответивший, останавливается по ответу.
- `streams_reset` (`resetStreams()` в `src/api/stream.ts`) вызывается один раз при загрузке страницы до первого стрима: останавливает подписки и терминалы, оставшиеся от прежней страницы окна; подключения и пробросы портов не трогает. Старт, начатый до сброса, отклоняется (`AppState::undo_if_reset`).
- Watch: на подписку один набор watcher'ов (по одному на неймспейс); фронтенд получает `Snapshot`, затем `Delta { upserted, deleted(uid) }`, `Reconnecting`, `Forbidden { namespaces }` (часть неймспейсов недоступна, остальные идут дальше), `Error` (запуск невозможен). `managedFields` вырезаны в ядре. `useWatch` складывает объекты в `Map<uid, obj>`. С `WatchSpec.metadataOnly` объекты приходят только как `{apiVersion, kind, metadata}`.
- События без id: `cluster-state` (`{ clusterId, state }`) и `portforwards` (`ForwardInfo[]`).
- Подписки, стримы и сессии лежат в `AppState` (`subscriptions`, `sessions`); их закрывает `*_stop`, `streams_reset`, закрытие окна (`window::on_run_event` → `close_all`) и `AppState::close_cluster` (отключение кластера закрывает и его проброски, и его локальные терминалы).

### Discovery

На кластер одна discovery: `ClusterManager::kinds` отдаёт общий результат всем ждущим и прекращается, когда ждать некому; сбрасывается при (пере)подключении и отключении. Сначала aggregated discovery (два запроса), иначе по версиям групп. `ResourceKind.printerColumns` из неё пуст: колонки CRD фронтенд читает лениво, одним CRD, когда вид открыт (`useCrdPrinterColumns`, `src/resources/crdColumns.ts`). Встроенные виды описаны в ядре (`BUILT_IN_KINDS` в `crates/sextant-core/src/resources/get.rs`), их watch не ждёт discovery. Сайдбар берёт CRD из discovery (`customResourceKinds` в `src/resources/useKinds.ts`). Решение — ADR-0015.

### GitOps: Flux и Argo CD

Flux и Argo CD — обычные CRD, поэтому всё идёт через Kubernetes API без CLI этих инструментов (ADR-0024). Их виды (`src/features/flux/`, `src/features/argocd/`) регистрируются в реестре видов в секциях сайдбара `flux` и `argocd`; раздел показывается, только если виды есть в discovery (ADR-0031). Действия (reconcile, suspend/resume, sync, refresh, terminate) — патчи объекта общей командой `resource_patch` (ADR-0025). Версию вида ядро выбирает через `resolve_kind`: get/watch/patch идут в версии из discovery, а `replace`/`apply` — в версии документа (ADR-0030).

**Сброс discovery.** CRD Flux и Argo CD появляются уже после подключения, поэтому фронтенд следит за CRD (`watchCrdChanges`, `src/resources/useKinds.ts`) и при добавлении или удалении зовёт `cluster_kinds_refresh`: `ClusterManager::refresh_kinds` сбрасывает общую discovery кластера без переподключения (ADR-0026).

**Argo CD: вход и дифф.** Ядро (`crates/sextant-core/src/argocd.rs`) находит установку Argo CD (ADR-0032) и говорит с её API через port-forward к `argocd-server`; проверка TLS отключена только для `127.0.0.1` (ADR-0027). Сессии живут в `ArgoSessions` (`src-tauri/src/commands/argocd.rs`, поле `AppState.argocd`) и закрываются вместе с кластером; команды — `src-tauri/src/commands/argocd.rs`. Источники входа и их порядок — ADR-0028, сохранённый вход в хранилище ОС — ADR-0029. Пароли и токены Argo остаются в backend. Дифф (`argocd_diff`) отдаёт управляемые ресурсы с желаемым и живым состоянием, значения Secret вырезаны; окно входа и вид диффа на `@codemirror/merge` — `src/features/argocd/diff/`, действие `argoDiff` подключает отдельная фича `src/features/argocd-diff/`.

### Клиент кластера: повторы и таймауты

`kube::Client` собирается в `cluster.rs` со своим слоем повторов (`RetryPolicy`: 429/503/504, не больше 3 раз и 5 с, только запросы с клонируемым телом); соединение — `CONNECT_TIMEOUT`. Команды, меняющие кластер, обёрнуты в `error::with_timeout` (`CHANGE_TIMEOUT` в `src-tauri/src/commands/actions.rs`) и дают `ErrorCode::Timeout`; drain и apply нескольких документов лимитируют каждый запрос (`resources::STEP_TIMEOUT`). Решения — ADR-0016, ADR-0023.

### Секреты

Ядро не отдаёт значения Kubernetes Secret во фронтенд: `resources::get::to_json` у `core/v1 Secret` заменяет значения `data`/`stringData` на `""`, ставит аннотацию `sextant.dev/values-hidden` и убирает `last-applied-configuration` — это относится и к watch, и к `resource_get`. Значение одного ключа — `secret_value`; объект целиком — `resource_get_full`, только для редактирования. Сохранение объекта с маркером `values-hidden` ядро отвергает (`ensure_values_present`). Решение — ADR-0014.

### Обновления приложения

Проверка и установка идут через плагины Tauri `updater` и `process`, обёрнутые в `src/api/updater.ts` (`api.updates`, транспорт — `src/api/transport.ts`, в тестах подменяется `mockBackend`). Состояние — `src/features/updates/store.ts`; интерфейс — `UpdateNotice` (проверка при старте, монтируется из `SettingsButton`) и `UpdatesPanel` (раздел Settings). Плагин updater регистрируется в `src-tauri/src/lib.rs` только при `plugins.updater.pubkey` и endpoint в `src-tauri/tauri.conf.json` (`updater_configured`); права окна — `src-tauri/capabilities/updates.json`. Релиз, подпись и `latest.json` — `.github/workflows/release.yml`, ADR-0022.

## Границы модулей

- **`sextant-core`** владеет всем про кластеры: kubeconfig, подключение и discovery, watch, действия над ресурсами, логи, exec, port-forward, метрики (metrics-server и Prometheus), Helm, настройки на диске. Прячет `kube-rs`, reflector'ы, разбор Helm-секретов, автопоиск Prometheus. Не зависит от `tauri` и `portable-pty`; всё, что запускает процессы ОС (бинарь `helm`), — за фичей `desktop` (в default). Это проверяет `scripts/check-core-deps.mjs`.
- **`sextant`** (`src-tauri/`) владеет `AppState`, командами, событиями, локальным PTY (`pty.rs`), геометрией окна (`window.rs`). Команда не содержит логики кластера — вызывает ядро. Новый вид подписки или сессии регистрируется в `AppState`, иначе его не закроет `close_cluster`.
- **`src/api/`** — единственное место, где вызываются `invoke` / `listen` и импортируется `@tauri-apps/api` (eslint запрещает в остальных местах). Исключение по ADR-0011: хуки кластеров лежат в `src/features/clusters`.
- **`src/features/<name>/`** — вертикальные фичи. Каталог с `index.ts` подхватывается сам (`import.meta.glob` в `src/app/features.ts`); фича подключает себя регистрациями, не правя чужие файлы.
- **`src/layout/`** — оболочка (`AppShell`: рейл кластеров, сайдбар, `MainView`, панель деталей, док). Не знает про конкретные виды ресурсов.
- **`src/resources/`** — реестр видов (`ResourceDef`: колонки, детали, действия); для CRD колонки берутся из `printerColumns` самого CRD, прочитанного лениво (`crdColumns.ts`).
- **`src/components/`** — общие компоненты без знания о Kubernetes-видах: `Button` (`variant`, `size`, `icon`, `iconOnly` + обязательный `label`), `Checkbox` и `Radio` (нативных чекбоксов и радиокнопок в приложении нет), `Tabs` (`tablist` с клавишами ←/→/Home/End), `icons.tsx` (`Icon`, `IconName`, `IconSpec`, `renderIcon`), `LoadingIndicator` (с подсказкой, если ждать долго), `Dialog`, `ConfirmDialog`, `ErrorState`, `EmptyState`, `Badge`, `Age`, `usePopup`; таблица ресурсов — `src/components/Table/` (`ResourceTable`, `LoadingTable`). Экспорт — `src/components/index.ts`; фичи импортируют отсюда, а не друг у друга.
- **`src/features/flux/`, `src/features/argocd/`, `src/features/argocd-diff/`** — GitOps (см. «GitOps: Flux и Argo CD»); работают только через api и реестры, ядру нужны лишь `resource_patch`, `cluster_kinds_refresh` и модуль `argocd`.
- **`src/features/updates/`** — обновления приложения и его версия (см. «Обновления приложения»); к реестрам не подключается, его компоненты встраивают `src/features/settings`.

## Кнопки, иконки, вкладки

- Все иконки — набор `lucide-react`, подключённый только в `src/components/icons.tsx`: `IconName` — имена набора, `IconSpec` — имя или текстовый глиф (совместимость), `renderIcon(spec)` рисует SVG (`aria-hidden`, без текста и `<title>`) либо глиф. Фичи импортируют `Icon`/`renderIcon` из `src/components`, не `lucide-react` (ADR-0033). `icons.test.tsx` требует использования каждого имени.
- Размеры — токены `:root` в `src/styles/global.css`: `--control-height` 32 px, `--control-height-compact` 28 px (кнопка «⋮» и кнопки строк таблиц, закрытие вкладки дока), `--control-font-size`, `--icon-size`; `.btn`, `.btn--compact`, `.btn--icon`, `.icon-btn` берут размеры оттуда (ADR-0034).
- Кнопка с иконкой вместо подписи (`iconOnly`) держит прежнюю подпись в `aria-label` и `title`; по этим именам находят кнопки vitest и e2e.
- Иконки в реестрах: `ActionDef.icon: IconSpec` (`src/features/actions/registry.ts`, рендер в `ActionBar` и `ActionMenu` таблицы), `DockActionDef.icon?: IconSpec`, `SidebarEntry.icon?: IconName` и `SECTION_ICONS` (иконка секции и одиночных разделов, ключ — `SidebarSection | "settings"`) с запасной `DEFAULT_ENTRY_ICON` — `src/resources/registry.ts`, `PageDef.icon?: IconName` — `src/layout/pages.ts`. Фича задаёт иконку полем `icon` в своей регистрации; сайдбар рисует её слева от подписи.
- `Tabs` — состояние выбранной вкладки хранит вызывающий; вкладки контейнеров пода (`ContainerList`, `src/features/details/kinds/pods.tsx`) держат выбор по ключу объекта `clusterId|namespace|name`, чтобы обновление пода его не сбрасывало.
- Requests и limits пода считает фронтенд: `podResourceAmounts` (`src/features/metrics/requests.ts`, CPU в милликорах, память в байтах) — видны и без metrics-server (ADR-0037).

## Иконка кластера и полоса

`ClusterSettings.icon` (Rust `ClusterIcon`: `Text { text }` или `Image { dataUrl }`) и `WindowLayout.railExpanded` лежат в `settings.json` и пишутся фронтендом (`settings_update`). Картинку вписывает в 96×96 PNG `readIconImage` (`src/features/clusters/iconImage.ts`, тип до 5 МБ); `iconOf` (`clusterSettings.ts`) отдаёт картинку, только если это `data:image/png;base64,`, иначе текст (`icon.text` или инициалы имени); общий рендер — `ClusterAvatar` для полосы и предпросмотра. `ClusterRail` (`src/layout/ClusterRail.tsx`) читает `railExpanded` из store (`setRailExpanded`) и в развёрнутом виде показывает имена; разворачивается узкая полоса кластеров, не меню разделов (ADR-0035, ADR-0036).

## Точки расширения (реестры)

| Что добавляется | Функция | Где реестр |
|---|---|---|
| вид ресурса | `registerResource`, `extendColumns` | `src/resources/registry.ts` |
| действие над объектом | `registerAction(id, def)` | `src/features/actions/registry.ts` |
| вкладка дока / кнопка дока | `registerDockTab`, `registerDockAction` | `src/layout/dock/registry.ts` |
| секция панели деталей | `registerDetailsSection` | `src/layout/details/registry.ts` |
| страница сайдбара | `registerPage` | `src/layout/pages.ts` |
| слот (`clusterRail`, `railFooter`, `welcome`) | `registerSlot` | `src/layout/slots.ts` |
| секция настроек кластера | `registerClusterSettingsSection` | `src/features/clusters/settingsRegistry.ts` |

Новое действие — это ещё и новый вариант в union `ActionId`. Страницы настроек и обновлений реестров не используют: `src/features/settings` показывает их сам (слот `railFooter` — кнопка Settings).

## Соглашения

- Имена в коде английские. Всё, что уходит во фронтенд, — `#[serde(rename_all = "camelCase")]` и `ts-rs`; TS-типы генерируются в `src/api/generated/` (`npm run gen:types`), руками не правятся, сгенерированные коммитятся. Имена команд и событий в генерацию не входят: они заданы вручную в `src/api/commands.ts` и `src/api/events.ts` и `src-tauri/src/lib.rs`, опечатку ловит только тест или рантайм.
- Любая строка интерфейса — ключ i18next в `src/locales/<lang>/<namespace>.json`, по неймспейсу на фичу; список языков строится из найденных каталогов. Литералы в JSX запрещает eslint.
- Одна ошибка на всё ядро: `CoreError { code: ErrorCode, message }`. Ошибки kube всегда идут через `error::kube_error` (вырезает секреты exec-плагина). Во фронтенде — `ApiError { code, message }`, код `ErrorCode` переводится по ключу из `errorKey`.
- Секреты из kubeconfig не логируются и не уходят во фронтенд. Значения Kubernetes Secret уходят только по явному запросу (`secret_value`, `resource_get_full`); любой новый путь, по которому объект Secret попадает во фронтенд, обязан идти через `resources::get::to_json`.
- Терминал и `helm` получают временный kubeconfig с одним контекстом, права 0600 (`write_temp_kubeconfig`, ADR-0010). Файл терминала принадлежит сессии (`TermSession.guard`) и удаляется синхронно при её остановке, остатки после падения чистятся при старте (ADR-0019); оболочка пользователя получает `KUBECONFIG` обратно после его rc (ADR-0018). Из окружения вызова `helm` вычищаются `HELM_KUBE*`, `HELM_NAMESPACE`, `HELM_DRIVER`, `KUBECONFIG`; единственная точка запуска — `HelmCli::command()`.
- Изменяющие вызовы ядра подписаны field manager `sextant`. Namespaced-ссылка без неймспейса даёт `invalid` (`ObjectRef::required_namespace`). Замена YAML без `resourceVersion` — `invalid`.
- Правило стримов: фронтенд создаёт id и вешает `listen` до `*_start(…, streamId)`, поэтому backend не придерживает вывод ни паузами, ни буфером: watch отдаёт первый снапшот сразу и дальше не чаще раза в 250 мс (`resources::watch::BATCH_INTERVAL`), логи — пачками по 100 мс (`logs::BATCH_INTERVAL`), терминал — сразу. Стрим открывается только через `openStream`; id проверяется `check_stream_id` (`[A-Za-z0-9_-]`, ≤128, занятый — `invalid`), подписка регистрируется в `AppState` до работы ядра. Решение — ADR-0013.
- Настройки: `settings_update` меняет только поля фронтенда; поля, которые пишет backend (`kubeconfigSources`, геометрия окна), сохраняются как записал backend. Новое поле backend'а — добавить в список сохраняемых в `update_settings`. Нечитаемый `settings.json` не перезаписывается (`settings_status`, ADR-0017).
- Версия приложения одна на пять манифестов (`Cargo.toml`, `Cargo.lock`, `tauri.conf.json`, `package.json`, `package-lock.json`); сверяет `scripts/check-version.mjs` (`npm run check:version`, в `npm run check` и в `release.yml`).
- Порты проброса слушают только 127.0.0.1.
- Слово «Lens» в продукте не используется, продукт — Sextant (`dev.sextant.app`).

## Швы для тестов

1. Ядро без кластера: юнит-тесты рядом с кодом; те, что должны видеть HTTP, идут в поддельный API-сервер `crates/sextant-core/src/fake_api.rs` (виден только в `cfg(test)`; ответы задаёт тест, каждый запрос записывается).
2. Ядро против kind: `crates/sextant-core/tests/<feature>.rs` + `crates/sextant-core/tests/common/mod.rs`; тесты GitOps (`gitops*.rs`) нужны ещё `SEXTANT_TEST_GITOPS=1` и кластер `up --gitops`, без них пропускаются; без `SEXTANT_TEST_KUBECONFIG` тест возвращается и считается пройденным. Тяжёлые замеры (большой кластер) берут фикстуру `scripts/fixtures/load/load.sh`.
3. Команды: `src-tauri/tests/commands.rs` вызывает каждую команду на mock-рантайме Tauri, изолирован от `KUBECONFIG` и `~/.kube/config` (`set_env`); команда, ходящая в сеть или запускающая `helm`, там подменяется.
4. Фронтенд: Vitest + Testing Library без Tauri, backend подменяет `mockBackend` из `src/api` (включая обновления и версию приложения).
5. Окно целиком: `e2e/` (WebdriverIO + `tauri-driver`) против kind, со своими XDG-каталогами во временной папке.
