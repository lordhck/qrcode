// Thin client for the QR Transfer REST API.

export class ApiError extends Error {
  constructor(status, detail) {
    super(detail || `Request failed (${status})`);
    this.status = status;
  }
}

async function json(response) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON error body: fall through with a generic message.
  }
  if (!response.ok) throw new ApiError(response.status, body?.detail);
  return body;
}

export async function getConfig() {
  return json(await fetch("/api/config", { cache: "no-store" }));
}

export async function createTransfer({ size, meta, ttlSeconds, fps }) {
  return json(
    await fetch("/api/transfers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ size, meta, ttl_seconds: ttlSeconds, fps }),
    }),
  );
}

/** Upload with progress reporting (fetch cannot report upload progress). */
export function uploadBlob(id, token, bytes, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/transfers/${encodeURIComponent(id)}/upload`);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
      else reject(new ApiError(xhr.status, xhr.response?.detail));
    };
    xhr.onerror = () => reject(new ApiError(0, "Network error during upload"));
    xhr.send(new Blob([bytes]));
  });
}

/** Returns {info, serverNow} where serverNow is the server clock in ms. */
export async function getTransfer(id) {
  const response = await fetch(`/api/transfers/${encodeURIComponent(id)}`, { cache: "no-store" });
  const info = await json(response);
  const date = Date.parse(response.headers.get("date") || "");
  return { info, serverNow: Number.isNaN(date) ? Date.now() : date };
}

export async function downloadBlob(id, expectedSize, onProgress) {
  const response = await fetch(`/api/transfers/${encodeURIComponent(id)}/blob`, { cache: "no-store" });
  if (!response.ok) await json(response);
  const out = new Uint8Array(expectedSize);
  const reader = response.body.getReader();
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (received + value.length > expectedSize) throw new Error("Download is larger than expected");
    out.set(value, received);
    received += value.length;
    onProgress?.(received / expectedSize);
  }
  if (received !== expectedSize) throw new Error("Download is incomplete");
  return out;
}

export async function deleteTransfer(id, token) {
  const response = await fetch(`/api/transfers/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) await json(response);
}
