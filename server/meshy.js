// Thin client for the Meshy REST API. Everything the app knows about Meshy is in
// this file. All behaviour claims verified against
// the official docs on 2026-08-04.

const BASE = "https://api.meshy.ai";

// Versioning is per-endpoint, not global: text-to-3d lives on v2 while the image
// endpoints are v1. Do not "simplify" this into one base path.
const ENDPOINTS = {
  "text-to-image": "/openapi/v1/text-to-image",
  "image-to-image": "/openapi/v1/image-to-image",
  "image-to-3d": "/openapi/v1/image-to-3d",
  "text-to-3d": "/openapi/v2/text-to-3d",
  balance: "/openapi/v1/balance",
};

const key = process.env.MESHY_API_KEY;

// No key is not an error: the server falls back to a read-only sample mode
// (see server.js) so the app can be explored before paying for API access.
export const hasKey = Boolean(key && key !== "replace_with_your_meshy_api_key");

class MeshyError extends Error {
  constructor(status, message, retryable) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

async function request(path, { method = "GET", body } = {}) {
  if (!hasKey) throw new MeshyError(401, "no API key configured (sample mode)", false);
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    // Request-level errors are a flat { message } body. 429 carries one of two
    // distinct messages: RateLimitExceeded (too many req/s — back off briefly)
    // or NoMoreConcurrentTasks (queue full — wait for a task to finish).
    let message = `HTTP ${res.status}`;
    try {
      message = (await res.json()).message ?? message;
    } catch {
      /* non-JSON error body; keep the status text */
    }
    const retryable = res.status === 429 || res.status >= 500;
    throw new MeshyError(res.status, message, retryable);
  }
  return res.json();
}

export const balance = async () => (await request(ENDPOINTS.balance)).balance;

// All create calls return { result: "<task-id>" } immediately; generation is async.
export async function createTask(kind, params) {
  const { result } = await request(ENDPOINTS[kind], { method: "POST", body: params });
  return result;
}

export const getTask = (kind, id) => request(`${ENDPOINTS[kind]}/${id}`);

export const isQueueFull = (err) =>
  err instanceof MeshyError && err.status === 429 && /NoMoreConcurrentTasks/i.test(err.message);

// Poll a task to a terminal state. A FAILED task arrives on HTTP 200 with the
// reason in task_error — moderation rejections included — so callers must check
// status, never just "did the request succeed".
//
// Transient poll failures (a network blip, a 5xx, a rate-limit) must not kill a
// generation that is still running server-side, so only consecutive misses give
// up. Permanent errors (401, 404 for a deleted task) still fail immediately.
export async function waitForTask(kind, id, { intervalMs = 5000, onProgress } = {}) {
  let misses = 0;
  for (;;) {
    let task;
    try {
      task = await getTask(kind, id);
      misses = 0;
    } catch (err) {
      const permanent = err instanceof MeshyError && !err.retryable;
      if (permanent || ++misses > 3) throw err;
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }
    onProgress?.(task);
    if (["SUCCEEDED", "FAILED", "CANCELED"].includes(task.status)) return task;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
