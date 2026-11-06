// Environment-based configuration. Every setting is a QRT_* variable;
// invalid values abort startup instead of silently falling back.

const KiB = 1024;
const MiB = 1024 * KiB;

// Protocol constants (not configurable).
export const MIN_CIPHERTEXT_BYTES = 12 + 16; // AES-GCM nonce + tag
export const MAX_META_BYTES = 1 * KiB;
export const MIN_FPS = 1;
export const MAX_JSON_BODY_BYTES = 16 * KiB;

const SPEC = {
  storageDir: { env: "STORAGE_DIR", type: "string", default: "storage" },
  maxSize: { env: "MAX_SIZE", type: "int", default: 10 * MiB },
  maxStorage: { env: "MAX_STORAGE", type: "int", default: 1024 * MiB },
  defaultTtl: { env: "DEFAULT_TTL", type: "int", default: 3600 },
  minTtl: { env: "MIN_TTL", type: "int", default: 60 },
  maxTtl: { env: "MAX_TTL", type: "int", default: 86400 },
  defaultFps: { env: "DEFAULT_FPS", type: "int", default: 10 },
  maxFps: { env: "MAX_FPS", type: "int", default: 15 },
  cleanupInterval: { env: "CLEANUP_INTERVAL", type: "int", default: 60 },
  createRateLimit: { env: "CREATE_RATE_LIMIT", type: "int", default: 20 },
  enforceHttps: { env: "ENFORCE_HTTPS", type: "bool", default: true },
  host: { env: "HOST", type: "string", default: "0.0.0.0" },
  port: { env: "PORT", type: "int", default: 8000 },
  trustedProxies: { env: "TRUSTED_PROXIES", type: "string", default: "127.0.0.1" },
  sslCertfile: { env: "SSL_CERTFILE", type: "string", default: "" },
  sslKeyfile: { env: "SSL_KEYFILE", type: "string", default: "" },
};

export class ConfigError extends Error {}

function parse(name, type, raw) {
  const value = raw.trim();
  if (type === "int") {
    if (!/^-?\d+$/.test(value)) throw new ConfigError(`QRT_${name} must be an integer, got "${raw}"`);
    return Number(value);
  }
  if (type === "bool") {
    if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
    if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
    throw new ConfigError(`QRT_${name} must be a boolean, got "${raw}"`);
  }
  return value;
}

export function loadConfig(env = process.env) {
  const c = {};
  for (const [key, spec] of Object.entries(SPEC)) {
    const raw = env[`QRT_${spec.env}`];
    c[key] = raw === undefined || raw.trim() === "" ? spec.default : parse(spec.env, spec.type, raw);
  }

  const check = (ok, message) => {
    if (!ok) throw new ConfigError(message);
  };
  for (const key of ["maxSize", "maxStorage", "minTtl", "cleanupInterval", "port"]) {
    check(c[key] > 0, `QRT_${SPEC[key].env} must be positive`);
  }
  check(c.createRateLimit >= 0, "QRT_CREATE_RATE_LIMIT must not be negative");
  check(c.maxSize >= MIN_CIPHERTEXT_BYTES, `QRT_MAX_SIZE must be at least ${MIN_CIPHERTEXT_BYTES}`);
  check(c.maxSize <= c.maxStorage, "QRT_MAX_SIZE must not exceed QRT_MAX_STORAGE");
  check(c.minTtl <= c.defaultTtl && c.defaultTtl <= c.maxTtl, "QRT_MIN_TTL <= QRT_DEFAULT_TTL <= QRT_MAX_TTL must hold");
  check(MIN_FPS <= c.defaultFps && c.defaultFps <= c.maxFps, "1 <= QRT_DEFAULT_FPS <= QRT_MAX_FPS must hold");
  check(c.port <= 65535, "QRT_PORT must be <= 65535");
  check(Boolean(c.sslCertfile) === Boolean(c.sslKeyfile), "QRT_SSL_CERTFILE and QRT_SSL_KEYFILE must be set together");
  return Object.freeze(c);
}
