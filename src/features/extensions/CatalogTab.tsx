// Settings → Extensions → Catalog (ADR-0130): the catalog's extensions, searched in the window over the backend's
// cached index, with Install / Update leading to the usual window of consent. Text only: no image is fetched.
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CatalogCategory, CatalogEntry, ExtensionInfo } from "../../api";
import { api } from "../../api";
import { Badge, Button, ErrorState, LoadingIndicator } from "../../components";
import { formatDateTime, formatNumber } from "../../i18n";
import { formatBytes } from "../metrics/format";
import { CATEGORIES, matches, offerOf, repositoryUrl, shownEntries, statusesOf, type CatalogState, type EntryOffer } from "./catalog";
import { PermissionsView } from "./PermissionsView";

const CONTRIBUTION_TYPES = ["pages", "detailsSections", "actions", "columns", "dockActions", "settings"] as const;

export interface CatalogTabProps {
  catalog: CatalogState;
  installed: readonly ExtensionInfo[];
  /** A check is running (Install or Update was pressed). */
  busy: boolean;
  onInstall: (id: string) => void;
}

export function CatalogTab({ catalog, installed, busy, onInstall }: CatalogTabProps) {
  const { t } = useTranslation();
  const searchId = useId();
  const categoryId = useId();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CatalogCategory | null>(null);
  const { view, loading, error, load } = catalog;
  const byId = useMemo(() => new Map(installed.map((e) => [e.id, e])), [installed]);
  const statuses = useMemo(() => statusesOf(view), [view]);
  const entries = useMemo(() => shownEntries(view, new Set(byId.keys())), [view, byId]);
  const found = entries.filter((entry) => matches(entry, query, category));
  const newer = view?.error?.message.startsWith("catalog::NEWER_INDEX") ?? false;

  if (error) return <ErrorState error={error} title={t("extensions:catalog.failed")} onRetry={() => void load(false)} />;
  if (!view) return <LoadingIndicator text={t("extensions:catalog.loading")} />;

  return (
    <div className="ext-catalog">
      <p className="settings__hint">{t("extensions:catalog.trust")}</p>
      <div className="ext-catalog__toolbar">
        <label className="settings__label" htmlFor={searchId}>
          {t("extensions:catalog.search")}
        </label>
        <input
          id={searchId}
          className="settings__input ext-catalog__search"
          type="search"
          value={query}
          placeholder={t("extensions:catalog.searchPlaceholder")}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="settings__label" htmlFor={categoryId}>
          {t("extensions:catalog.category")}
        </label>
        <select
          id={categoryId}
          className="settings__select"
          value={category ?? ""}
          onChange={(e) => setCategory(e.target.value === "" ? null : (e.target.value as CatalogCategory))}
        >
          <option value="">{t("extensions:catalog.allCategories")}</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {t(`extensions:catalog.categories.${c}`)}
            </option>
          ))}
        </select>
        <Button icon="refresh" disabled={loading} onClick={() => void load(true)}>
          {t("extensions:catalog.refresh")}
        </Button>
      </div>
      <p className="ext-catalog__status" aria-live="polite">
        {loading
          ? t("extensions:catalog.loading")
          : view.fetchedAt !== null
            ? t("extensions:catalog.updatedAt", { date: formatDateTime(view.fetchedAt) })
            : null}
      </p>
      {view.error && newer && <p className="ext-row__alert" data-tone="warning">{t("extensions:catalog.newerFormat")}</p>}
      {view.error && !newer && view.index && view.fetchedAt !== null && (
        <p className="ext-row__alert" data-tone="warning">
          {t("extensions:catalog.staleNote", { date: formatDateTime(view.fetchedAt), message: view.error.message })}
        </p>
      )}
      {view.error && !newer && !view.index && (
        <ErrorState error={view.error} title={t("extensions:catalog.failed")} onRetry={() => void load(true)} />
      )}
      {view.index && view.index.skipped > 0 && (
        <p className="settings__hint">{t("extensions:catalog.skipped", { count: view.index.skipped })}</p>
      )}
      {view.index && entries.length === 0 && <p className="settings__hint">{t("extensions:catalog.empty")}</p>}
      {entries.length > 0 && found.length === 0 && <p className="settings__hint">{t("extensions:catalog.noMatch")}</p>}
      {found.length > 0 && (
        <ul className="ext-list" aria-label={t("extensions:tabs.catalog")}>
          {found.map((entry) => (
            <CatalogEntryCard
              key={entry.id}
              entry={entry}
              offer={offerOf(entry, byId.get(entry.id), statuses.get(entry.id))}
              busy={busy}
              onInstall={() => onInstall(entry.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function OfferControl({ entry, offer, busy, onInstall }: { entry: CatalogEntry; offer: EntryOffer; busy: boolean; onInstall: () => void }) {
  const { t } = useTranslation();
  switch (offer.kind) {
    case "install":
      return (
        <Button
          variant="primary"
          size="compact"
          disabled={busy}
          aria-label={t("extensions:catalog.installNamed", { name: entry.name })}
          onClick={onInstall}
        >
          {t("extensions:catalog.install")}
        </Button>
      );
    case "update":
      return (
        <Button
          variant="primary"
          size="compact"
          disabled={busy}
          aria-label={t("extensions:catalog.updateNamed", { name: entry.name, version: offer.version })}
          onClick={onInstall}
        >
          {t("extensions:catalog.updateTo", { version: offer.version })}
        </Button>
      );
    case "installed":
      return <Badge tone="success">{t("extensions:catalog.installed")}</Badge>;
    case "otherSource":
      return <Badge tone="neutral">{t("extensions:catalog.otherSource")}</Badge>;
    case "pinnedElsewhere":
      return <Badge tone="warning">{t("extensions:catalog.pinnedElsewhere")}</Badge>;
    case "needsNewer":
      return <Badge tone="neutral">{t("extensions:catalog.needsNewer", { version: offer.version })}</Badge>;
    case "withdrawn":
      return <Badge tone="danger">{t("extensions:catalog.withdrawn")}</Badge>;
  }
}

function CatalogEntryCard({ entry, offer, busy, onInstall }: { entry: CatalogEntry; offer: EntryOffer; busy: boolean; onInstall: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const latest = entry.latest;
  const counts = latest
    ? CONTRIBUTION_TYPES.filter((type) => latest.contributes[type] > 0).map((type) => ({
        type,
        count: latest.contributes[type],
      }))
    : [];
  return (
    <li className="ext-row" aria-label={entry.name}>
      <div className="ext-row__main">
        <div className="ext-row__info">
          <div className="ext-row__title">
            <strong>{entry.name}</strong>
            {latest && <span className="ext-row__version">{t("extensions:list.version", { version: latest.version })}</span>}
            {entry.categories.map((c) => (
              <Badge key={c} tone="neutral">
                {t(`extensions:catalog.categories.${c}`)}
              </Badge>
            ))}
          </div>
          <div className="ext-row__meta">{t("extensions:catalog.by", { author: entry.author })}</div>
          <div className="ext-row__description">{entry.description}</div>
        </div>
      </div>
      {offer.kind === "withdrawn" && (
        <p className="ext-row__alert" data-tone="danger" role="alert">
          {t("extensions:catalogStatus.withdrawn", { reason: offer.reason })}
        </p>
      )}
      <div className="ext-row__actions">
        <OfferControl entry={entry} offer={offer} busy={busy} onInstall={onInstall} />
        <Button
          size="compact"
          aria-expanded={open}
          aria-controls={detailsId}
          aria-label={t("extensions:catalog.detailsNamed", { name: entry.name })}
          onClick={() => setOpen((v) => !v)}
        >
          {t("extensions:catalog.details")}
        </Button>
        <Button
          size="compact"
          icon="external"
          aria-label={t("extensions:catalog.openRepository", { repository: entry.repository })}
          onClick={() => void api.shell.openUrl(repositoryUrl(entry.repository))}
        >
          {t("extensions:catalog.repository")}
        </Button>
      </div>
      {open && (
        <div id={detailsId} className="ext-catalog__details">
          <dl className="ext-consent__facts">
            <dt>{t("extensions:catalog.repository")}</dt>
            <dd className="ext-consent__source">{entry.repository}</dd>
            <dt>{t("extensions:catalog.publisherKey")}</dt>
            <dd className="ext-consent__source">{entry.keyId}</dd>
            {latest?.publishedAt && (
              <>
                <dt>{t("extensions:catalog.published")}</dt>
                <dd>{formatDateTime(latest.publishedAt)}</dd>
              </>
            )}
            {latest && (
              <>
                <dt>{t("extensions:catalog.size")}</dt>
                <dd>{formatBytes(latest.size)}</dd>
              </>
            )}
          </dl>
          {counts.length > 0 && (
            <>
              <h3 className="ext-consent__heading">{t("extensions:consent.adds")}</h3>
              <ul className="ext-catalog__counts">
                {counts.map(({ type, count }) => (
                  <li key={type}>
                    {t("extensions:catalog.contribution", { what: t(`extensions:contributes.${type}`), count: formatNumber(count) })}
                  </li>
                ))}
              </ul>
            </>
          )}
          <h3 className="ext-consent__heading">{t("extensions:consent.permissions")}</h3>
          <p className="settings__hint">{t("extensions:catalog.asPublished")}</p>
          {latest?.permissions ? (
            <PermissionsView permissions={latest.permissions} />
          ) : (
            <p className="settings__hint">{t("extensions:catalog.permissionsUnreadable")}</p>
          )}
        </div>
      )}
    </li>
  );
}
