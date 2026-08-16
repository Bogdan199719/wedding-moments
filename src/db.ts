import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

fs.mkdirSync(config.dataDir, { recursive: true });
export const uploadsDir = path.join(config.dataDir, "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });
export const uploadSessionsDir = path.join(config.dataDir, "upload-sessions");
fs.mkdirSync(uploadSessionsDir, { recursive: true });
export const db = new Database(path.join(config.dataDir, "wedding.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  upload_id TEXT NOT NULL,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK(media_type IN ('photo','video')),
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS media_sha_size ON media(sha256, size);
CREATE INDEX IF NOT EXISTS media_created ON media(created_at DESC);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS upload_sessions (
  id TEXT PRIMARY KEY,
  upload_id TEXT NOT NULL,
  original_name TEXT NOT NULL,
  declared_mime TEXT NOT NULL,
  expected_size INTEGER NOT NULL,
  offset INTEGER NOT NULL DEFAULT 0,
  temp_name TEXT NOT NULL UNIQUE,
  guest_name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  client_ip TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  completed_media_id TEXT
);`);
db.exec("CREATE INDEX IF NOT EXISTS upload_sessions_expires ON upload_sessions(expires_at)");
const mediaColumns = db.prepare("PRAGMA table_info(media)").all() as Array<{ name: string }>;
if (!mediaColumns.some((column) => column.name === "guest_name")) {
  db.exec("ALTER TABLE media ADD COLUMN guest_name TEXT NOT NULL DEFAULT 'Гость'");
}
if (!mediaColumns.some((column) => column.name === "delete_token_hash")) {
  db.exec("ALTER TABLE media ADD COLUMN delete_token_hash TEXT NOT NULL DEFAULT ''");
}

export type Media = {
  id: string; upload_id: string; original_name: string; stored_name: string;
  size: number; mime: string; media_type: "photo" | "video";
  sha256: string; status: string; created_at: string;
  guest_name: string;
  delete_token_hash: string;
};

export type UploadSession = {
  id: string; upload_id: string; original_name: string; declared_mime: string;
  expected_size: number; offset: number; temp_name: string; guest_name: string;
  token_hash: string; client_ip: string; created_at: number; expires_at: number;
  completed_media_id: string | null;
};
