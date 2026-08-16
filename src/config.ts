import path from "node:path";

const number = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Некорректная переменная ${name}`);
  return value;
};

export const config = {
  host: process.env.HOST ?? "0.0.0.0",
  port: number("PORT", 3000),
  publicUrl: process.env.PUBLIC_URL ?? "http://localhost:3000",
  dataDir: path.resolve(process.env.DATA_DIR ?? "./data"),
  adminUsername: process.env.ADMIN_USERNAME ?? "admin",
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH ?? "",
  sessionSecret: process.env.SESSION_SECRET ?? "development-only-secret-change-me-now",
  maxFileBytes: number("MAX_FILE_BYTES", 1024 * 1024 * 1024),
  maxUploadBytes: number("MAX_UPLOAD_BYTES", 1024 * 1024 * 1024),
  uploadChunkBytes: number("UPLOAD_CHUNK_BYTES", 4 * 1024 * 1024),
  uploadSessionTtlMs: number("UPLOAD_SESSION_TTL_MS", 24 * 60 * 60 * 1000),
  minFreeBytes: number("MIN_FREE_BYTES", 2 * 1024 * 1024 * 1024),
  trustProxy: process.env.TRUST_PROXY === "true",
  production: process.env.NODE_ENV === "production",
};

if (config.production && (config.sessionSecret.length < 32 || !config.adminPasswordHash)) {
  throw new Error("В production задайте SESSION_SECRET (32+ символа) и ADMIN_PASSWORD_HASH");
}
