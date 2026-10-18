# Translating Sextant

The interface texts live in `src/locales/<language>/<namespace>.json`. English (`en/`) is the source: every other
language has the same files and the same keys. A new directory is a new language: it appears in
Settings → General → Appearance → Language, and on first start Sextant picks it when the operating system uses that
language. The directories are:

| Directory | Language | Directory | Language |
|---|---|---|---|
| `ru` | Russian | `pl` | Polish |
| `uk` | Ukrainian | `tr` | Turkish |
| `de` | German | `zh-CN` | Chinese (Simplified) |
| `fr` | French | `zh-TW` | Chinese (Traditional) |
| `es` | Spanish | `ja` | Japanese |
| `pt-BR` | Portuguese (Brazil) | `ko` | Korean |
| `it` | Italian | | |

OS languages map to them by the primary subtag (`de-AT` → `de`); Chinese by script or region (`zh-Hans`, `zh-CN`,
`zh-SG` → `zh-CN`; `zh-Hant`, `zh-TW`, `zh-HK`, `zh-MO` → `zh-TW`; one script never stands in for the other); any
Portuguese → `pt-BR`. Without a match the interface is English.

## Check your work

```sh
npx vitest run src/locales/locales.test.ts   # keys, placeholders, plural forms, markup, empty texts
cargo test -p sextant tray                    # the tray menu has every text (tray.json)
```

The test compares each language with English and fails on:

- a file or a key English has that the language lacks, or a key English does not have;
- an empty text;
- a `{{placeholder}}`, a `$t(…)` or a tag (`<owner>`, `<b>`) that differs from English;
- plural forms other than the language's CLDR categories (see below).

A key that is missing at run time still shows the English text (`fallbackLng`), but a release must not depend on it.

## Rules

**Keep exactly, character for character**

- Placeholders: `{{name}}`, `{{count}}`, `{{kind}}`. Move them where the grammar needs them; never translate,
  rename, drop or add one. A placeholder is filled with a name or a number from the cluster, already formatted.
- Nesting: `$t(namespace:key)` is replaced by another text; leave it as it is.
- Markup-like text: `<owner>`, `<repo>` and similar are parts of a URL pattern, not tags; keep them.
- Kubernetes kinds and API terms: Pod, Deployment, StatefulSet, DaemonSet, ReplicaSet, Job, CronJob, Service,
  Ingress, ConfigMap, Secret, Node (as a kind), Namespace/namespace, CRD, HTTPRoute, Gateway, listener,
  label, annotation, selector, taint, toleration, finalizer, owner reference, `kubeconfig`, context, `kubectl`,
  `metadata.name` and every other field name. Use them as English words inside your sentence (`Pod web-1 не готов`).
- Product and project names: Sextant, Kubernetes, Helm, Flux, Argo CD, Gateway API, MCP, Prometheus, metrics-server,
  cert-manager, GitHub, kind, AWS/EKS, Google Cloud/GKE, Azure/AKS, `aws`, `gcloud`, `az`.
- Commands, paths, file names, environment variables, YAML, code: `~/.kube/config`, `helm repo add`, `KUBECONFIG`.
- Keyboard shortcuts and key names: `Ctrl+K`, `⌘K`, `Esc`, `Enter`, `Shift`.
- Units of Kubernetes quantities (`m`, `Mi`, `Gi`, `KiB`, `MiB`) and condition values (`True`, `False`, `Unknown`),
  status reasons from the cluster (`CrashLoopBackOff`, `OOMKilled`, `ImagePullBackOff`), HTTP methods and codes.

**Translate**

- Common words, also when they name Kubernetes ideas in a sentence: cluster, node, container, log, event, problem,
  settings, overview, connection, port forward, terminal, shell, release (Helm), revision, replica. Use the glossary
  below so the same word is the same everywhere.
- Page and section titles that are not kind names ("Overview", "Problems", "Events", "Port forwarding").
- The short ages in `common:age.*` (`{{count}}s` → `{{count}} с` / `{{count}}秒`), keeping them short: they sit in
  narrow table columns.
- `common:list.separator`: what joins names in a list (`", "` in English; `"、"` in Chinese and Japanese;
  `", "` in Korean and the European languages). `common:list.dot` separates parts of one line
  (`"eu-west-1 · 1.31 · ACTIVE"`, `" · "` in English).

**Plural forms**

English has `key_one` and `key_other`; i18next picks the form by `count` with `Intl.PluralRules`. A translation has
exactly the forms of its language — no more, no fewer:

| Forms | Languages |
|---|---|
| `_one`, `_other` | de, tr (and en) |
| `_one`, `_many`, `_other` | fr, es, it, pt-BR — `_many` is for very large round numbers (1 000 000); it usually reads like `_other` (fr: « 1 million de pods ») |
| `_one`, `_few`, `_many`, `_other` | ru, uk, pl |
| `_other` only | zh-CN, zh-TW, ja, ko |

Every form keeps the placeholders of English `_other`, `{{count}}` included: Russian `_one` is also used for 21, 31,
101. A text for exactly one object without a number has its own key (`actions:delete.titleSingle`), not a plural
form. A key without `_one`/`_other` in English stays one key in every language, even when it contains `{{count}}`
("Showing {{count}}" is a label, not a phrase that agrees with the number).

**Sentences**

- Each key is a whole sentence or a whole label; the code never glues keys together into one sentence, so word order
  is yours. When the wording depends on a case (all namespaces or some of them, a cloud problem with or without its
  account), each case is a key of its own. If a text cannot be translated well because of how it is split, open an
  issue instead of working around it.
- A plural key agrees with `{{count}}` only. Another number in the same text (`{{max}}`, `{{total}}`, `{{problems}}`)
  stands where nothing has to agree with it — after a colon, in "of {{total}}", in parentheses ("{{problems}} in
  total"); keep it there.
- A placeholder that holds a list of labels (`{{actions}}`: "read, modify") is already joined with
  `common:list.separator`; its items are written as in the middle of a sentence (lowercase where the language
  allows), so put it where such a list reads well (after a colon).
- Dates, times and numbers come already formatted for the language (`Intl`), so do not write formats into texts.

**Tone and length**

- Concise interface language. Buttons and menu items are imperative verbs ("Delete", "Restart", "Apply"); in
  languages where the UI convention is the infinitive or a noun (de "Löschen", fr "Supprimer", ja 「削除」), follow the
  convention of the operating system.
- Address the user the way the OS does: ru/uk formal «вы» (lowercase), de "Sie", fr "vous", es/pt-BR/it neutral
  (avoid the pronoun where possible), pl impersonal forms, tr formal, ja/ko polite plain UI style (です/ます only in
  full sentences, 합니다 style in full sentences in Korean).
- `…` at the end of a button means "opens a dialog"; keep it. Keep the punctuation that introduces a list (`:`).
- Use the language's quotation marks: «» (ru, uk, fr with spaces), „“ (de, pl), “” (es, pt-BR, it, tr, zh-CN, ko),
  「」 (ja, zh-TW).
- Texts get longer (German and Russian by a third, often more): buttons do not wrap, so prefer the shorter of two good
  words for a button, a tab or a column header. Long hints and messages wrap freely.
- Do not use HTML or Markdown: texts are shown as plain text.

**Tray and notifications**

`tray.json` is the tray icon's menu (outside the window); `notifications.json` holds the desktop notifications. Both
follow the chosen language.

## Glossary

Use these words so the whole interface says the same thing. Capitalize as a button or a title of your language
requires; inflect as the sentence requires. "Keep" means the English word stays.

| English | ru | uk | de | fr | es | pt-BR | it | pl | tr | zh-CN | zh-TW | ja | ko |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| cluster | кластер | кластер | Cluster | cluster | clúster | cluster | cluster | klaster | küme | 集群 | 叢集 | クラスター | 클러스터 |
| node | узел | вузол | Knoten | nœud | nodo | nó | nodo | węzeł | düğüm | 节点 | 節點 | ノード | 노드 |
| container | контейнер | контейнер | Container | conteneur | contenedor | contêiner | container | kontener | kapsayıcı | 容器 | 容器 | コンテナー | 컨테이너 |
| pod logs | логи Pod | логи Pod | Pod-Logs | journaux du Pod | registros del Pod | logs do Pod | log del Pod | logi Poda | Pod günlükleri | Pod 日志 | Pod 日誌 | Pod のログ | Pod 로그 |
| settings | настройки | налаштування | Einstellungen | paramètres | configuración | configurações | impostazioni | ustawienia | ayarlar | 设置 | 設定 | 設定 | 설정 |
| connect | подключить | підключити | verbinden | se connecter | conectar | conectar | connetti | połącz | bağlan | 连接 | 連線 | 接続 | 연결 |
| disconnect | отключить | відключити | trennen | se déconnecter | desconectar | desconectar | disconnetti | rozłącz | bağlantıyı kes | 断开连接 | 中斷連線 | 切断 | 연결 끊기 |
| apply | применить | застосувати | anwenden | appliquer | aplicar | aplicar | applica | zastosuj | uygula | 应用 | 套用 | 適用 | 적용 |
| delete | удалить | видалити | löschen | supprimer | eliminar | excluir | elimina | usuń | sil | 删除 | 刪除 | 削除 | 삭제 |
| restart | перезапустить | перезапустити | neu starten | redémarrer | reiniciar | reiniciar | riavvia | uruchom ponownie | yeniden başlat | 重启 | 重新啟動 | 再起動 | 다시 시작 |
| scale | масштабировать | масштабувати | skalieren | mettre à l'échelle | escalar | escalar | scala | skaluj | ölçeklendir | 伸缩 | 調整規模 | スケール | 스케일 조정 |
| details | подробности | подробиці | Details | détails | detalles | detalhes | dettagli | szczegóły | ayrıntılar | 详细信息 | 詳細資料 | 詳細 | 세부 정보 |
| events | события | події | Ereignisse | événements | eventos | eventos | eventi | zdarzenia | olaylar | 事件 | 事件 | イベント | 이벤트 |
| problems | проблемы | проблеми | Probleme | problèmes | problemas | problemas | problemi | problemy | sorunlar | 问题 | 問題 | 問題 | 문제 |
| notifications | уведомления | сповіщення | Benachrichtigungen | notifications | notificaciones | notificações | notifiche | powiadomienia | bildirimler | 通知 | 通知 | 通知 | 알림 |
| overview | обзор | огляд | Übersicht | vue d'ensemble | resumen | visão geral | panoramica | przegląd | genel bakış | 概览 | 概觀 | 概要 | 개요 |
| search | поиск | пошук | suchen | rechercher | buscar | pesquisar | cerca | szukaj | ara | 搜索 | 搜尋 | 検索 | 검색 |
| cancel | отмена | скасувати | abbrechen | annuler | cancelar | cancelar | annulla | anuluj | iptal | 取消 | 取消 | キャンセル | 취소 |
| close | закрыть | закрити | schließen | fermer | cerrar | fechar | chiudi | zamknij | kapat | 关闭 | 關閉 | 閉じる | 닫기 |
| namespace | keep | keep | keep | keep | keep | keep | keep | keep | keep | keep | keep | keep | keep |

"Events" as a page title is translated; the kind `Event` is not. "Node" as a kind name (the Nodes list in the
sidebar, `{{kind}}`) stays English; "node" in a sentence is translated.
