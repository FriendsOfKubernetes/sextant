# ADR-0025: Действия GitOps идут через общую команду `resource_patch`, а не командой на каждое действие

## Контекст

Для Flux и Argo CD нужны десять действий (`reconcile`, `reconcileWithSource`, `fluxSuspend`, `fluxResume`, `argoSync`, `argoRefresh`, `argoHardRefresh`, `argoTerminate` и др.). Все сводятся к патчу аннотации или поля объекта. Общей команды merge- или JSON-патча не было. Существующие действия заточены под свой вид: `workload_restart` принимает только apps Deployment, StatefulSet, DaemonSet (`ensure_kind`), `cronjob_suspend` — только batch/CronJob. Вспомогательные `patch_params()` и `object_api` в `mutate.rs` наружу не экспортировались. Новая команда по заведённому порядку трогает ядро, `lib.rs`, `src/api/commands.ts`, `src-tauri/tests/commands.rs` и `mockBackend`.

## Решение

Ядро: `resources::patch(mgr, cluster, &ObjectRef, &Value, PatchType) -> CoreResult<Value>`, `PatchType { Merge, Json }`, field manager `sextant`, ответ через `to_json`. Команда `resource_patch(clusterId, ref, patch, patchType)` под `with_timeout(CHANGE_TIMEOUT)` (30 с, ADR-0016); TS `api.resources.patch(clusterId, ref, patch, "merge" | "json")` возвращает объект. Патч, называющий `sextant.dev/values-hidden`, отвергается с кодом `invalid`. Flux и Argo CD пользуются только `"merge"`.

## Почему

- Так записано в спецификации: фича не заводит команду на каждое действие.
- Команда на действие отвергнута: десять действий — это десять комплектов правок в пяти местах, и в каждом пришлось бы повторять резолв вида и параметры патча.
- Зачем в контракте `"json"`, если сборка его не использует, в материалах не сказано.
- Запрет маркера `sextant.dev/values-hidden` держит инвариант ADR-0014: объект с маркером не должен быть записан обратно.

## Последствия

- Любой код фронтенда может патчить любой объект: ограничения по видам, как в `workload_restart` и `cronjob_suspend`, у общей команды нет. Единственная проверка содержимого — запрет маркера Secret. Других проверок в материалах нет.
- Ответ идёт через `to_json`, поэтому патч Secret не вернёт значения в окно (ADR-0014).
- Ошибки kube проходят через `kube_error`; конфликт сервера — `Conflict`. Просрочка 30 с не отменяет патч на сервере (ADR-0016): действие, показанное как ошибка, могло примениться.
- Прежние команды (`workload_restart`, `cronjob_suspend`) остались; перевод их на общую команду в материалах не планировался. Теперь есть два пути для однотипных изменений.
- Merge-патч заменяет списки целиком. Это касается и `operation.sync.syncOptions`, которые Sync пишет сам.
