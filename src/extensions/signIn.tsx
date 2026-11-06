// `ui.signIn` of an extension (#354, ADR-0160): Sextant's own dialog asks the fields a service of the extension
// declares (`contributes.services[].signIn`), and sends what the user types straight to Rust
// (`extension_service_sign_in`): the frame never sees it. "Remember" keeps it in the OS keyring for that cluster.
import { useId, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError, type ClusterId, type ServiceContribution } from "../api";
import { Button, Checkbox, Dialog } from "../components";

interface Question {
  extensionId: string;
  extensionName: string;
  clusterId: ClusterId;
  namespace: string;
  service: ServiceContribution;
  answer: (signedIn: boolean) => void;
}

let questions: Question[] = [];
const listeners = new Set<() => void>();

function changed(next: Question[]): void {
  questions = next;
  for (const listener of [...listeners]) listener();
}

/** Asks the user to sign in to `service` of the extension; `true` once Sextant has what they typed. */
export function askSignIn(question: Omit<Question, "answer">): Promise<boolean> {
  if (!question.service.signIn) {
    return Promise.reject(new ApiError("invalid", `ui.signIn: service ${question.service.id} has no sign-in`));
  }
  if (questions.some((q) => q.extensionId === question.extensionId)) {
    return Promise.reject(new ApiError("conflict", "ui.signIn: the user is already asked to sign in"));
  }
  return new Promise<boolean>((resolve) => {
    const asked: Question = {
      ...question,
      answer: (signedIn) => {
        changed(questions.filter((q) => q !== asked));
        resolve(signedIn);
      },
    };
    changed([...questions, asked]);
  });
}

/** Declines every open sign-in of `extensionId` (it went away). */
export function declineSignIns(extensionId: string): void {
  for (const q of questions.filter((q) => q.extensionId === extensionId)) q.answer(false);
}

export function resetSignIns(): void {
  changed([]);
}

/** The dialog of the oldest question. */
export function SignInHost() {
  const list = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => questions,
  );
  const question = list[0];
  return question ? <SignInDialog key={`${question.extensionId}:${question.service.id}`} question={question} /> : null;
}

function SignInDialog({ question }: { question: Question }) {
  const { t } = useTranslation();
  const baseId = useId();
  const fields = question.service.signIn?.fields ?? [];
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.id, ""])));
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.extensions.serviceSignIn(
        question.extensionId,
        question.clusterId,
        question.namespace,
        question.service.id,
        values,
        remember,
      );
      question.answer(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title={t("extensions:host.signIn.title", { service: question.service.title })}
      onClose={() => question.answer(false)}
      footer={
        <>
          <Button onClick={() => question.answer(false)}>{t("common:actions.cancel")}</Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>
            {t("extensions:host.signIn.submit")}
          </Button>
        </>
      }
    >
      <form
        className="ext-sign-in"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p>{t("extensions:host.signIn.text", { extension: question.extensionName, namespace: question.namespace })}</p>
        {fields.map((field, i) => (
          <label key={field.id} className="ext-sign-in__field" htmlFor={`${baseId}-${i}`}>
            <span>{field.label}</span>
            <input
              id={`${baseId}-${i}`}
              type={field.secret ? "password" : "text"}
              autoComplete="off"
              value={values[field.id] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [field.id]: e.target.value }))}
            />
          </label>
        ))}
        <label className="settings__choice">
          <Checkbox checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          {t("extensions:host.signIn.remember")}
        </label>
        <p className="settings__hint">{t("extensions:host.signIn.hint")}</p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
