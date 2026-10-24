"use client";
import { appStorage, withBase } from "@/lib/base-path";

import { useCallback, useEffect, useState } from "react";

/** An error from the API, carrying the human-readable message the server sent. */
export class ApiError extends Error {
  constructor(message: string, public status: number, public approval?: ApprovalNeed) {
    super(message);
  }
}

/** What an action above the user's limit needs approving (the server's 403 "approval" object). */
export type ApprovalNeed = { kind: "discount" | "refund" | "cash_out"; amount: number; late: boolean; orderId: string | null; shiftId: string | null };

/**
 * Asks a manager (PIN here, or a request they approve remotely): resolves with the approval's id, or null when not approved.
 * Set by <ApprovalHost />; while it's mounted, any write refused for a limit asks and is sent again with the approval.
 */
let approvalHandler: ((need: ApprovalNeed, message: string) => Promise<string | null>) | null = null;
export function setApprovalHandler(h: typeof approvalHandler) {
  approvalHandler = h;
}

async function failure(res: Response, fallback: string): Promise<ApiError> {
  let message = fallback;
  try {
    const body = await res.json();
    message = body.error ?? message;
    if (body.approval) return new ApiError(message, res.status, body.approval as ApprovalNeed);
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(message, res.status);
}

let currentCompanyId: string | null = null;
let currentBranchId: string | null = null;

/** Every request carries the active company and branch; the server checks access and RLS isolates the data. */
export function setApiScope(companyId: string | null, branchId: string | null) {
  currentCompanyId = companyId;
  currentBranchId = branchId;
}

/**
 * The register a back-office browser takes payments at (picked on the Dashboard), per branch; a till's comes from its PIN sign-in.
 * Sent as X-Register-Id: with it the user opens a shift there, and payments count in that drawer.
 */
const registerKey = (branchId: string) => `onepos.register.${branchId}`;
export function pickedRegister(branchId: string | null = currentBranchId): string | null {
  if (!branchId) return null;
  try { return appStorage.getItem(registerKey(branchId)); } catch { return null; }
}
export function pickRegister(branchId: string, registerId: string | null) {
  try { if (registerId) appStorage.setItem(registerKey(branchId), registerId); else appStorage.removeItem(registerKey(branchId)); } catch { /* storage unavailable */ }
}

type Method = "GET" | "POST" | "PUT" | "DELETE";

/** This browser tab's id: the server keeps one device editing an order at a time (REQ TBL-08). */
let deviceSession: string | null = null;
export function deviceSessionId(): string {
  if (deviceSession) return deviceSession;
  try {
    deviceSession = sessionStorage.getItem("onepos.session");
    if (!deviceSession) { deviceSession = `tab-${newKey()}`.slice(0, 60); sessionStorage.setItem("onepos.session", deviceSession); }
  } catch {
    deviceSession = `tab-${newKey()}`.slice(0, 60);
  }
  return deviceSession;
}

/** A fresh key per write, so a retry of the same write (REQ ONL-02) can't apply twice. */
export const newKey = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/**
 * Calls the API. Writes carry an Idempotency-Key and are retried on a dropped connection (up to 3 tries) with the same key:
 * the server answers the first result instead of doing it twice. A 401 sends the user to sign in.
 */
export async function api<T = unknown>(path: string, method: Method = "GET", body?: unknown, opts: { key?: string; approvalId?: string } = {}): Promise<T> {
  const key = method === "GET" ? undefined : opts.key ?? newKey();
  let lastError: unknown;
  for (let attempt = 0; attempt < (method === "GET" ? 1 : 3); attempt++) {
    let res: Response;
    try {
      res = await fetch(withBase(`/api${path}`), {
        method,
        credentials: "same-origin",
        headers: {
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(currentCompanyId ? { "X-Company-Id": currentCompanyId } : {}),
          ...(currentBranchId ? { "X-Branch-Id": currentBranchId } : {}),
          ...(pickedRegister() ? { "X-Register-Id": pickedRegister()! } : {}),
          "X-Device-Session": deviceSessionId(),
          ...(key ? { "Idempotency-Key": key } : {}),
          ...(opts.approvalId ? { "X-Approval-Id": opts.approvalId } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      // The connection dropped: wait a moment and send the same request (same key) again.
      lastError = e;
      window.dispatchEvent(new CustomEvent(CONNECTION_EVENT, { detail: "down" }));
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      continue;
    }
    window.dispatchEvent(new CustomEvent(CONNECTION_EVENT, { detail: "up" }));
    if (res.status === 401 && !path.startsWith("/auth")) {
      window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
      throw new ApiError("Your session has ended. Please sign in again.", 401);
    }
    if (!res.ok) {
      const err = await failure(res, `Request failed (${res.status}).`);
      // Above a limit: ask a manager, then send the same action again with the approval (once).
      if (err.approval && approvalHandler && !opts.approvalId) {
        const approvalId = await approvalHandler(err.approval, err.message);
        if (approvalId) return api<T>(path, method, body, { approvalId });
        throw new ApiError("Not approved, so nothing was changed.", 403);
      }
      if (!err.approval) reportApiError(method, path, err);
      throw err;
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
  const dropped = new ApiError(lastError instanceof Error ? "No connection to the server. Check the network and try again." : "Request failed.", 0);
  reportApiError(method, path, dropped);
  throw dropped;
}

/** Fired with "down" / "up" as requests fail to connect or succeed (the shell shows "Reconnecting…", REQ ONL-03). */
export const CONNECTION_EVENT = "onepos:connection";
/** Fired when the server says the session ended. */
export const SIGNED_OUT_EVENT = "onepos:signed-out";
/** Fired for every refused or failed request, so "Report a problem" can send the user's recent errors (components/feedback.tsx). */
export const API_ERROR_EVENT = "onepos:api-error";

function reportApiError(method: string, path: string, err: ApiError) {
  window.dispatchEvent(new CustomEvent(API_ERROR_EVENT, { detail: { method, path, status: err.status, message: err.message } }));
}

/** Loads `path` (null = don't load yet) and reloads when the path, scope or `reload()` changes; keeps the previous data while reloading. */
export function useApi<T>(path: string | null) {
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const key = path === null ? null : `${currentCompanyId}|${currentBranchId}|${path}|${version}`;
  const [result, setResult] = useState<{ key: string | null; data?: T; error: string | null }>({ key: null, error: null });

  useEffect(() => {
    if (key === null || path === null) return;
    let cancelled = false;
    api<T>(path)
      .then((data) => !cancelled && setResult({ key, data, error: null }))
      .catch((e: Error) => !cancelled && setResult((r) => ({ key, data: r.data, error: e.message })));
    return () => {
      cancelled = true;
    };
  }, [key, path]);

  return { data: result.data, error: result.error, loading: key !== null && result.key !== key, reload };
}

/** Uploads a file (multipart form, field "file") to `path`; same scope headers and error handling as `api`. */
export async function apiUpload<T = unknown>(path: string, file: Blob, name = "upload"): Promise<T> {
  const form = new FormData();
  form.append("file", file, name);
  const res = await fetch(withBase(`/api${path}`), {
    method: "POST",
    credentials: "same-origin",
    headers: {
      ...(currentCompanyId ? { "X-Company-Id": currentCompanyId } : {}),
      ...(currentBranchId ? { "X-Branch-Id": currentBranchId } : {}),
      "Idempotency-Key": newKey(),
    },
    body: form,
  });
  if (!res.ok) {
    const err = await failure(res, res.status === 413 ? "The file is too large." : `Upload failed (${res.status}).`);
    reportApiError("POST", path, err);
    throw err;
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * Shrinks a photo in the browser before upload: longest side `max` px, WebP (JPEG where WebP isn't supported), ~80 % quality.
 * A 6 MB phone photo becomes ~60 KB, so it uploads in a moment and loads instantly on the tills.
 */
export async function shrinkImage(file: File, max = 640): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/webp", 0.8));
  return blob && blob.type === "image/webp" ? blob : await new Promise<Blob>((r, x) => canvas.toBlob((b) => (b ? r(b) : x(new Error("Couldn't read the photo."))), "image/jpeg", 0.85));
}
