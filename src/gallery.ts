import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { requireAdmin } from "./auth.js";
import { config } from "./config.js";
import { db, uploadsDir, type Media } from "./db.js";

const galleryUrl = "/gallery";
const defaultLimit = 30;
const maxLimit = 60;
const thumbnailsDir = path.join(config.dataDir, "gallery-thumbnails");

db.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  INSERT OR IGNORE INTO app_settings(key, value) VALUES ('gallery_enabled', '0');
`);
fs.mkdirSync(thumbnailsDir, { recursive: true });

type GalleryRow = Pick<Media, "id" | "size" | "mime" | "media_type" | "created_at">;
type Cursor = { createdAt: string; id: string };

export function registerGalleryRoutes(app: FastifyInstance) {
  app.get("/api/admin/gallery", { preHandler: requireAdmin }, async () => gallerySettings());

  app.put("/api/admin/gallery", { preHandler: requireAdmin }, async (request, reply) => {
    const enabled = (request.body as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled !== "boolean") return reply.code(400).send({ error: "Поле enabled должно быть логическим значением" });
    db.prepare("UPDATE app_settings SET value=? WHERE key='gallery_enabled'").run(enabled ? "1" : "0");
    return gallerySettings();
  });

  app.get("/api/gallery", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (!isGalleryEnabled()) return galleryUnavailable(reply);
    const query = request.query as { cursor?: string; limit?: string | number; type?: string };
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    if (query.cursor && !cursor) return reply.code(400).send({ error: "Некорректный курсор галереи" });
    const mediaType = query.type === "photo" || query.type === "video" ? query.type : null;
    const conditions = ["status='ready'"];
    const params: Array<string | number> = [];
    if (mediaType) { conditions.push("media_type=?"); params.push(mediaType); }
    if (cursor) {
      conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
      params.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    params.push(limit + 1);
    const rows = db.prepare(`
      SELECT id,size,mime,media_type,created_at
      FROM media
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...params) as GalleryRow[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    reply.header("Cache-Control", "no-store");
    return {
      enabled: true,
      items: page.map(publicItem),
      nextCursor: hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null,
    };
  });

  app.route({
    method: ["GET", "HEAD"],
    url: "/api/gallery/media/:id",
    config: { rateLimit: { max: 300, timeWindow: "1 minute" } },
    handler: async (request, reply) => serveOriginal(request, reply),
  });

  app.get("/api/gallery/display/:id", { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } }, async (request, reply) => {
    return servePhotoRendition(request, reply, "display", 2048, 88);
  });
  app.get("/api/gallery/thumb/:id", { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } }, async (request, reply) => {
    return servePhotoRendition(request, reply, "thumb", 640, 80);
  });
}

function gallerySettings() {
  return { enabled: isGalleryEnabled(), url: galleryUrl };
}

function isGalleryEnabled() {
  const row = db.prepare("SELECT value FROM app_settings WHERE key='gallery_enabled'").get() as { value: string } | undefined;
  return row?.value === "1";
}

function galleryUnavailable(reply: FastifyReply) {
  return reply.code(404).header("Cache-Control", "no-store").send({ error: "Галерея пока закрыта" });
}

function publicItem(row: GalleryRow) {
  const url = row.media_type === "photo"
    ? `/api/gallery/display/${encodeURIComponent(row.id)}`
    : `/api/gallery/media/${encodeURIComponent(row.id)}`;
  return {
    id: row.id,
    type: row.media_type,
    mime: row.mime,
    size: row.size,
    createdAt: row.created_at,
    url,
    thumbnailUrl: row.media_type === "photo" ? `/api/gallery/thumb/${encodeURIComponent(row.id)}` : null,
  };
}

function parseLimit(value: unknown) {
  const parsed = Number(value ?? defaultLimit);
  return Number.isInteger(parsed) ? Math.min(maxLimit, Math.max(1, parsed)) : defaultLimit;
}

function encodeCursor(cursor: Cursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: unknown): Cursor | null {
  if (typeof value !== "string" || !value || value.length > 512) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<Cursor>;
    if (typeof decoded.createdAt !== "string" || !Number.isFinite(Date.parse(decoded.createdAt))) return null;
    if (typeof decoded.id !== "string" || !/^[0-9a-f-]{36}$/i.test(decoded.id)) return null;
    return { createdAt: decoded.createdAt, id: decoded.id };
  } catch { return null; }
}

function readyMedia(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  return db.prepare("SELECT * FROM media WHERE id=? AND status='ready'").get(id) as Media | undefined;
}

function safeStoredPath(media: Media) {
  if (!media.stored_name || path.basename(media.stored_name) !== media.stored_name) return null;
  const target = path.join(uploadsDir, media.stored_name);
  return fs.existsSync(target) ? target : null;
}

async function serveOriginal(request: FastifyRequest, reply: FastifyReply) {
  if (!isGalleryEnabled()) return galleryUnavailable(reply);
  const media = readyMedia((request.params as { id: string }).id);
  const target = media && safeStoredPath(media);
  if (!media || !target || media.media_type !== "video") return reply.code(404).send({ error: "Файл не найден" });
  const stat = await fsp.stat(target);
  const range = parseRange(request.headers.range, stat.size);
  reply.header("Accept-Ranges", "bytes").header("Cache-Control", "no-store").type(media.mime);
  if (request.headers.range && !range) {
    return reply.code(416).header("Content-Range", `bytes */${stat.size}`).send();
  }
  if (range) {
    reply.code(206)
      .header("Content-Range", `bytes ${range.start}-${range.end}/${stat.size}`)
      .header("Content-Length", String(range.end - range.start + 1));
    if (request.method === "HEAD") return reply.send();
    return reply.send(fs.createReadStream(target, range));
  }
  reply.header("Content-Length", String(stat.size));
  if (request.method === "HEAD") return reply.send();
  return reply.send(fs.createReadStream(target));
}

async function servePhotoRendition(request: FastifyRequest, reply: FastifyReply, variant: "display" | "thumb", maxPixels: number, quality: number) {
  if (!isGalleryEnabled()) return galleryUnavailable(reply);
  const media = readyMedia((request.params as { id: string }).id);
  if (!media || media.media_type !== "photo") return reply.code(404).send({ error: "Файл не найден" });
  const source = safeStoredPath(media);
  if (!source) return reply.code(404).send({ error: "Файл не найден" });
  const rendition = path.join(thumbnailsDir, `${media.id}-${media.sha256.slice(0, 16)}-${variant}.webp`);
  try {
    await fsp.access(rendition);
  } catch {
    const temporary = `${rendition}.${process.pid}-${Date.now()}.part`;
    try {
      // rotate() respects EXIF orientation; WebP output intentionally strips EXIF/GPS metadata.
      await sharp(source, { limitInputPixels: 64_000_000, sequentialRead: true }).rotate()
        .resize({ width: maxPixels, height: maxPixels, fit: "inside", withoutEnlargement: true })
        .webp({ quality, effort: 3 }).toFile(temporary);
      await fsp.rename(temporary, rendition).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
        await fsp.rm(temporary, { force: true });
      });
    } catch {
      await fsp.rm(temporary, { force: true });
      return reply.code(415).header("Cache-Control", "no-store").send({ error: "Превью этого формата пока недоступно" });
    }
  }
  return reply.header("Cache-Control", "no-store").type("image/webp").send(fs.createReadStream(rendition));
}

function parseRange(header: string | undefined, size: number) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size < 1) return null;
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}
