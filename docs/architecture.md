# Архитектура Sextant

Три слоя, зависимости только сверху вниз: `src/` (React) → `src-tauri/` (крейт `sextant`) → `crates/sextant-core/`.
Почему так решено — `docs/adr/`; значение слов — `CONTEXT.md`.

## Поток данных

```
kubeconfig ──► KubeconfigRegistry ──► ClusterManager ──► kube::Client
                                          │                  │
                           ConnectionState (broadcast)       ├─ resources::watch  ─► Stream<WatchUpdate>   (пачки 250 мс)
                                          │                  ├─ logs::stream_logs ─► Stream<LogUpdate>     (пачки 100 мс)
                                          │                  ├─ exec::exec_shell  ─► ExecSession
                                          │                  ├─ PortForwarder     ─► broadcast<Vec<ForwardInfo>>
                                          ▼                  └─ get / mutate / metrics / helm (запрос-ответ)
                        src-tauri: команды (invoke) и события (emit)
                                          │
                        src/api: invoke / listen / openStream, mockBackend для тестов
                                          │
                        хуки (useWatch, useClusters, …) ─► zustand store + реестры ─► компоненты
```

- Запрос-ответ: компонент → `api.<группа>.<метод>` → `invoke("<command>")` → тонкая команда в `src-tauri/src/commands/<feature>.rs` → функция ядра → `Result<T, CoreError>`.
- Живые данные: `*_start` возвращает id, backend пересылает поток ядра событиями `watch:<id>`, `logs:<id>`, `term:<id>`; общий порядок start → listen → unsubscribe → stop держит `openStream` (`src/api/stream.ts`).
- Watch: один watcher на подписку; фронтенд получает `Snapshot`, затем `Delta { upserted, deleted(uid) }`, `Reconnecting`, `Error`. `managedFields` вырезаны в ядре. `useWatch` складывает объекты в `Map<uid, obj>`.
- События без id: `cluster-state` (`{ clusterId, state }`) и `portforwards` (`ForwardInfo[]`).
- Подписки, стримы и сессии лежат в `AppState` (`subscriptions`, `sessions`); их закрывает `*_stop`, закрытие окна и `AppState::close_cluster` / `close_all` (отключение кластера закрывает и его проброски, и его локальные терминалы).

## Границы модулей

- **`sextant-core`** владеет всем про кластеры: kubeconfig, подключение и discovery, watch, действия над ресурсами, логи, exec, port-forward, метрики (metrics-server и Prometheus), Helm, настройки на диске. Прячет `kube-rs`, reflector'ы, разбор Helm-секретов, автопоиск Prometheus. Не зависит от `tauri` и `portable-pty`; всё, что запускает процессы ОС (бинарь `helm`), — за фичей `desktop` (в default). Это проверяет `scripts/check-core-deps.mjs`.
- **`sextant`** (`src-tauri/`) владеет `AppState`, командами, событиями, локальным PTY (`pty.rs`), геометрией окна (`window.rs`). Команда не содержит логики кластера — вызывает ядро. Новый вид подписки или сессии регистрируется в `AppState`, иначе его не закроет `close_cluster`.
- **`src/api/`** — единственное место, где вызываются `invoke` / `listen` и импортируется `@tauri-apps/api` (eslint запрещает в остальных местах). Исключение по ADR-0011: хуки кластеров лежат в `src/features/clusters`.
- **`src/features/<name>/`** — вертикальные фичи. Каталог с `index.ts` подхватывается сам (`import.meta.glob` в `src/app/features.ts`); фича подключает себя регистрациями, не правя чужие файлы.
- **`src/layout/`** — оболочка (`AppShell`: рейл кластеров, сайдбар, `MainView`, панель деталей, док). Не знает про конкретные виды ресурсов.
- **`src/resources/`** — реестр видов (`ResourceDef`: колонки, детали, действия); для CRD описание строится из `printerColumns`.
- **`src/components/`** — общие компоненты без знания о Kubernetes-видах (таблица `ResourceTable`, диалоги, `ErrorState`, `usePopup`).

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

Новое действие — это ещё и новый вариант в union `ActionId`.

## Соглашения

- Имена в коде английские. Всё, что уходит во фронтенд, — `#[serde(rename_all = "camelCase")]` и `ts-rs`; TS-типы генерируются в `src/api/generated/` (`npm run gen:types`), руками не правятся, сгенерированные коммитятся. Имена команд и событий в генерацию не входят: они заданы вручную в `src/api/commands.ts` и `src/api/events.ts` и `src-tauri/src/lib.rs`, опечатку ловит только тест или рантайм.
- Любая строка интерфейса — ключ i18next в `src/locales/<lang>/<namespace>.json`, по неймспейсу на фичу; список языков строится из найденных каталогов. Литералы в JSX запрещает eslint.
- Одна ошибка на всё ядро: `CoreError { code: ErrorCode, message }`. Ошибки kube всегда идут через `error::kube_error` (вырезает секреты exec-плагина). Во фронтенде — `ApiError { code, message }`, код `ErrorCode` переводится по ключу из `errorKey`.
- Секреты из kubeconfig не логируются и не уходят во фронтенд; исключение — содержимое Kubernetes Secret по явному «показать».
- Терминал и `helm` получают временный kubeconfig с одним контекстом, права 0600 (`write_temp_kubeconfig`, ADR-0010). Из окружения вызова `helm` вычищаются `HELM_KUBE*`, `HELM_NAMESPACE`, `HELM_DRIVER`, `KUBECONFIG`; единственная точка запуска — `HelmCli::command()`.
- Изменяющие вызовы ядра подписаны field manager `sextant`. Namespaced-ссылка без неймспейса даёт `invalid` (`ObjectRef::required_namespace`). Замена YAML без `resourceVersion` — `invalid`.
- Правило стримов: фронтенд вешает `listen` после ответа `*_start`, поэтому backend не теряет ранний вывод. Watch — первый батч не раньше 250 мс; логи — первая пачка через `LISTENER_GRACE` (300 мс); терминал — вывод держится до первого `term_resize` / `term_input`. Каждое такое правило доказано тестом; новый стрим обязан его соблюдать и иметь такой тест.
- Настройки: `settings_update` меняет только поля фронтенда; поля, которые пишет backend (`kubeconfigSources`, геометрия окна), сохраняются как записал backend. Новое поле backend'а — добавить в список сохраняемых в `update_settings`.
- Порты проброса слушают только 127.0.0.1.
- Слово «Lens» в продукте не используется, продукт — Sextant (`dev.sextant.app`).

## Швы для тестов

1. Ядро против kind: `crates/sextant-core/tests/<feature>.rs` + `tests/common/mod.rs`; без `SEXTANT_TEST_KUBECONFIG` тест возвращается и считается пройденным. Юнит-тесты лежат рядом с кодом.
2. Команды: `src-tauri/tests/commands.rs` вызывает каждую команду на mock-рантайме Tauri, изолирован от `KUBECONFIG` и `~/.kube/config` (`set_env`); команда, ходящая в сеть или запускающая `helm`, там подменяется.
3. Фронтенд: Vitest + Testing Library без Tauri, backend подменяет `mockBackend` из `src/api`.
4. Окно целиком: `e2e/` (WebdriverIO + `tauri-driver`) против kind, со своими XDG-каталогами во временной папке.
