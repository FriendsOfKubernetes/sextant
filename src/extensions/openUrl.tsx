// `ui.openUrl` of an extension (ADR-0156): an address opened in the system browser only after the user says so in
// Sextant's own dialog, every time, with the address shown in full. Only http(s), without a user or password in it, at
// most `MAX_URL_CHARS`; one question per extension at a time.
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api";
import { ConfirmDialog } from "../components";

/** Longest address an extension may ask to open. */
export const MAX_URL_CHARS = 2048;

interface Question {
  id: number;
  extension: string;
  extensionName: string;
  url: string;
  answer: (open: boolean) => void;
}

let questions: Question[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function changed(next: Question[]): void {
  questions = next;
  for (const listener of [...listeners]) listener();
}

/** The address as it will be opened; throws `invalid` for anything else than a plain http(s) address. */
export function checkedUrl(value: unknown): string {
  const bad = (why: string) => new ApiError("invalid", `ui.openUrl: ${why}`);
  if (typeof value !== "string" || value.trim() === "") throw bad("needs {url}");
  if (value.length > MAX_URL_CHARS) throw bad(`at most ${MAX_URL_CHARS} characters`);
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw bad("not an address");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw bad("only http and https addresses open");
  if (url.username !== "" || url.password !== "") throw bad("an address with a user or password never opens");
  return url.toString();
}

/** Asks the user whether to open `url` for the extension; opens it on "Open". `false` when declined. */
export function askOpenUrl(extension: string, extensionName: string, value: unknown): Promise<boolean> {
  const url = checkedUrl(value);
  if (questions.some((q) => q.extension === extension)) {
    return Promise.reject(new ApiError("conflict", "ui.openUrl: the user is already asked about another address"));
  }
  return new Promise<boolean>((resolve) => {
    const question: Question = {
      id: nextId++,
      extension,
      extensionName,
      url,
      answer: (open) => {
        changed(questions.filter((q) => q !== question));
        if (open) void api.shell.openUrl(url);
        resolve(open);
      },
    };
    changed([...questions, question]);
  });
}

/** Declines every open question of `extension` (it went away). */
export function declineOpenUrl(extension: string): void {
  for (const q of questions.filter((q) => q.extension === extension)) q.answer(false);
}

/** The dialogs: the oldest question first. */
export function OpenUrlHost() {
  const { t } = useTranslation();
  const list = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => questions,
  );
  const question = list[0];
  if (!question) return null;
  return (
    <ConfirmDialog
      open
      title={t("extensions:host.openUrl.title")}
      confirmLabel={t("extensions:host.openUrl.open")}
      onConfirm={() => question.answer(true)}
      onCancel={() => question.answer(false)}
    >
      <p>{t("extensions:host.openUrl.text", { extension: question.extensionName })}</p>
      <p className="ext-open-url">{question.url}</p>
    </ConfirmDialog>
  );
}

/** Tests: no question left. */
export function resetOpenUrl(): void {
  changed([]);
}
