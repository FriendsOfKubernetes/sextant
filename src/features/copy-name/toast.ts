// A short confirmation at the bottom of the window ("Copied …"), drawn by `CopyToast`. One message at a time: a new
// one replaces the last, and each disappears after `TOAST_MS`.
import { create } from "zustand";

export const TOAST_MS = 2500;

export interface ToastMessage {
  /** Grows with every message, so the same text shown twice restarts the timer. */
  id: number;
  text: string;
  tone: "info" | "error";
}

interface ToastState {
  message: ToastMessage | null;
}

export const useToast = create<ToastState>()(() => ({ message: null }));

let next = 0;

export function showToast(text: string, tone: ToastMessage["tone"] = "info"): void {
  next += 1;
  useToast.setState({ message: { id: next, text, tone } });
}

export function hideToast(id?: number): void {
  const current = useToast.getState().message;
  if (current && (id === undefined || current.id === id)) useToast.setState({ message: null });
}
