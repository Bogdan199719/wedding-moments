import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import staticPlugin from "@fastify/static";
import archiver from "archiver";
import crypto from "node:crypto";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import QRCode from "qrcode";
import { config } from "./config.js";
import { createSession, isAdmin, logout, requireAdmin, verifyPassword } from "./auth.js";
import { db, uploadsDir, type Media } from "./db.js";
import { saveUpload } from "./upload.js";
import { appendUploadChunk, completeUploadSession, createUploadSession, getUploadSession, terminateUploadSession, UploadSessionError } from "./resumable.js";
import { registerGalleryRoutes } from "./gallery.js";
import { BulkDeleteError, deleteAllMedia } from "./bulk-delete.js";

export function buildApp() {
  const app = Fastify({ logger: true, trustProxy: config.trustProxy, bodyLimit: 1024 * 1024 });
  app.register(cookie, { secret: config.sessionSecret });
  app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  app.register(multipart, {
    limits: { files: 20, fileSize: config.maxFileBytes, parts: 22 },
    throwFileSizeLimit: false,
  });
  app.addContentTypeParser("application/offset+octet-stream", { parseAs: "buffer", bodyLimit: config.uploadChunkBytes }, (_request, body, done) => done(null, body));
  app.register(staticPlugin, { root: path.resolve("public"), prefix: "/assets/" });

  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("Permissions-Policy", "camera=(self)")
      .header("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' blob:; media-src 'self' blob:; frame-ancestors 'none'");
  });

  app.get("/", async (_req, reply) => reply.type("text/html; charset=utf-8").send(await fsp.readFile(path.resolve("public/index.html"))));
  app.get("/gallery", async (_req, reply) => reply.header("Cache-Control", "no-store").type("text/html; charset=utf-8").send(await fsp.readFile(path.resolve("public/gallery.html"))));
  app.get("/health", async () => ({ status: "ok", database: db.prepare("SELECT 1 ok").get() ? "ok" : "error" }));
  registerGalleryRoutes(app);

  app.post("/api/upload-sessions", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = request.body as { sessionId?: string; uploadId?: string; name?: string; type?: string; size?: number; guestName?: string };
    try {
      const { session, token } = await createUploadSession({
        sessionId: String(body?.sessionId ?? ""), uploadId: String(body?.uploadId ?? ""), originalName: String(body?.name ?? ""),
        declaredMime: String(body?.type ?? ""), expectedSize: Number(body?.size),
        guestName: String(body?.guestName ?? ""), clientIp: request.ip,
      });
      return reply.code(201)
        .header("Cache-Control", "no-store")
        .header("Location", `/api/upload-sessions/${session.id}`)
        .header("Upload-Offset", "0")
        .header("Upload-Length", String(session.expected_size))
        .header("Upload-Expires", new Date(session.expires_at).toUTCString())
        .send({ id: session.id, token, offset: 0, chunkSize: config.uploadChunkBytes, expiresAt: session.expires_at });
    } catch (error) { return sendUploadSessionError(reply, error); }
  });

  app.head("/api/upload-sessions/:id", { config: { rateLimit: { max: 180, timeWindow: "1 minute" } } }, async (request, reply) => {
    try {
      const session = getUploadSession((request.params as { id: string }).id, String(request.headers["x-upload-token"] ?? ""));
      return reply.code(204).header("Cache-Control", "no-store")
        .header("Upload-Offset", String(session.offset)).header("Upload-Length", String(session.expected_size))
        .header("Upload-Expires", new Date(session.expires_at).toUTCString()).send();
    } catch (error) { return sendUploadSessionError(reply, error); }
  });

  app.patch("/api/upload-sessions/:id", { config: { bodyLimit: config.uploadChunkBytes, rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (request, reply) => {
    try {
      const session = await appendUploadChunk(
        (request.params as { id: string }).id,
        String(request.headers["x-upload-token"] ?? ""),
        Number(request.headers["upload-offset"]),
        request.body as Buffer,
      );
      return reply.code(204).header("Cache-Control", "no-store")
        .header("Upload-Offset", String(session.offset)).header("Upload-Expires", new Date(session.expires_at).toUTCString()).send();
    } catch (error) { return sendUploadSessionError(reply, error); }
  });

  app.post("/api/upload-sessions/:id/complete", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const token = String(request.headers["x-upload-token"] ?? "");
    try {
      const session = getUploadSession(id, token);
      const { media, duplicate } = await completeUploadSession(id, token);
      return reply.code(201).header("Cache-Control", "no-store").send({
        id: media.id, name: media.original_name, type: media.media_type, duplicate,
        deleteToken: media.upload_id === session.upload_id ? makeGuestDeleteToken(media) : null,
      });
    } catch (error) { return sendUploadSessionError(reply, error); }
  });

  app.delete("/api/upload-sessions/:id", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    try {
      await terminateUploadSession((request.params as { id: string }).id, String(request.headers["x-upload-token"] ?? ""));
      return reply.code(204).send();
    } catch (error) { return sendUploadSessionError(reply, error); }
  });

  app.post("/api/uploads", { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } }, async (request, reply) => {
    let uploadId: string = crypto.randomUUID();
    const results: Array<{ media: Media; deleteToken: string | null; duplicate: boolean }> = [];
    let total = 0;
    let guestName = "";
    const stat = await fsp.statfs(config.dataDir);
    if (Number(stat.bavail) * Number(stat.bsize) < config.minFreeBytes) return reply.code(507).send({ error: "На сервере временно недостаточно места" });
    try {
      for await (const part of request.parts()) {
        if (part.type === "field") {
          if (part.fieldname === "guestName") guestName = String(part.value).trim().replace(/\s+/g, " ").slice(0, 80);
          if (part.fieldname === "uploadId" && !results.length && /^[0-9a-f-]{36}$/i.test(String(part.value))) uploadId = String(part.value);
          continue;
        }
        if (!guestName) {
          part.file.resume();
          throw new Error("Укажите ваше имя");
        }
        results.push(await saveUpload(part, uploadId, guestName));
        total += results.at(-1)?.media.size ?? 0;
        if (total > config.maxUploadBytes) throw new Error("Общий объём загрузки превышён");
      }
      if (!results.length) return reply.code(400).send({ error: "Файлы не выбраны" });
      return reply.code(201).send({
        uploadId,
        files: results.map(({ media, deleteToken, duplicate }) => ({
          id: media.id,
          name: media.original_name,
          type: media.media_type,
          deleteToken: deleteToken ?? (duplicate && media.upload_id === uploadId ? makeGuestDeleteToken(media) : null),
          duplicate,
        })),
      });
    } catch (error) {
      for (const result of results.filter(({ duplicate }) => !duplicate)) {
        await fsp.rm(path.join(uploadsDir, result.media.stored_name), { force: true });
        db.prepare("DELETE FROM media WHERE id=?").run(result.media.id);
      }
      request.log.warn({ err: error }, "upload_failed");
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Не удалось загрузить файлы" });
    }
  });

  app.delete("/api/uploads/:id", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const media = db.prepare("SELECT * FROM media WHERE id=?").get((request.params as { id: string }).id) as Media | undefined;
    const token = String(request.headers["x-delete-token"] ?? "");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const storedTokenMatches = Boolean(media?.delete_token_hash) && safeEqual(tokenHash, media!.delete_token_hash);
    const retryTokenMatches = Boolean(media) && safeEqual(token, makeGuestDeleteToken(media!));
    if (!media || !token || (!storedTokenMatches && !retryTokenMatches)) {
      return reply.code(404).send({ error: "Файл не найден или уже удалён" });
    }
    await fsp.rm(path.join(uploadsDir, media.stored_name), { force: true });
    db.prepare("DELETE FROM media WHERE id=?").run(media.id);
    return reply.code(204).send();
  });

  app.get("/admin", async (_req, reply) => reply.header("X-Robots-Tag", "noindex, nofollow").type("text/html; charset=utf-8").send(await fsp.readFile(path.resolve("public/admin.html"))));
  app.post("/api/admin/login", { config: { rateLimit: { max: 8, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const body = request.body as { username?: string; password?: string };
    if (body?.username !== config.adminUsername || !verifyPassword(body?.password ?? "", config.adminPasswordHash)) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      return reply.code(401).send({ error: "Неверное имя пользователя или пароль" });
    }
    createSession(reply);
    return { ok: true };
  });
  app.post("/api/admin/logout", { preHandler: requireAdmin }, async (request, reply) => { logout(request, reply); return { ok: true }; });
  app.get("/api/admin/me", async (request, reply) => isAdmin(request) ? { authenticated: true } : reply.code(401).send({ authenticated: false }));
  app.get("/api/admin/media", { preHandler: requireAdmin }, async (request) => {
    const order = (request.query as { order?: string }).order === "asc" ? "ASC" : "DESC";
    const items = db.prepare(`SELECT id,original_name,size,mime,media_type,created_at,guest_name FROM media ORDER BY created_at ${order}`).all();
    const stats = db.prepare("SELECT COUNT(*) count, COALESCE(SUM(size),0) bytes FROM media").get();
    return { items, stats };
  });
  app.delete("/api/admin/media", { preHandler: requireAdmin, config: { rateLimit: { max: 3, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const body = request.body as { confirmation?: unknown; expectedCount?: unknown } | null;
    if (body?.confirmation !== "УДАЛИТЬ ВСЕ") {
      return reply.code(400).send({ error: "Введите фразу «УДАЛИТЬ ВСЕ»" });
    }
    try {
      const deleted = await deleteAllMedia(Number(body.expectedCount));
      request.log.warn({ deleted }, "all_media_deleted_by_admin");
      return { deleted };
    } catch (error) {
      const status = error instanceof BulkDeleteError ? error.statusCode : 500;
      request.log.error({ err: error }, "bulk_media_delete_failed");
      return reply.code(status).send({ error: error instanceof Error ? error.message : "Не удалось удалить все файлы" });
    }
  });
  app.get("/api/admin/media/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const media = db.prepare("SELECT * FROM media WHERE id=?").get((request.params as { id: string }).id) as Media | undefined;
    if (!media) return reply.code(404).send({ error: "Файл не найден" });
    const friendly = friendlyName(media);
    reply.header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(friendly)}`).type(media.mime);
    return reply.send(fs.createReadStream(path.join(uploadsDir, media.stored_name)));
  });
  app.delete("/api/admin/media/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const media = db.prepare("SELECT * FROM media WHERE id=?").get((request.params as { id: string }).id) as Media | undefined;
    if (!media) return reply.code(404).send({ error: "Файл не найден" });
    await fsp.rm(path.join(uploadsDir, media.stored_name), { force: true });
    db.prepare("DELETE FROM media WHERE id=?").run(media.id);
    return reply.code(204).send();
  });
  app.get("/api/admin/archive", { preHandler: requireAdmin }, async (_request, reply) => {
    reply.header("Content-Type", "application/zip").header("Content-Disposition", 'attachment; filename="wedding-media.zip"');
    const archive = archiver("zip", { zlib: { level: 1 } });
    archive.on("error", (error) => reply.raw.destroy(error));
    archive.pipe(reply.raw);
    for (const media of db.prepare("SELECT * FROM media ORDER BY created_at").iterate() as Iterable<Media>) {
      archive.file(path.join(uploadsDir, media.stored_name), { name: friendlyName(media) });
    }
    void archive.finalize();
    return reply;
  });
  app.get("/api/admin/qr", { preHandler: requireAdmin }, async (request, reply) => {
    const format = (request.query as { format?: string }).format === "svg" ? "svg" : "png";
    if (format === "svg") {
      const svg = await QRCode.toString(config.publicUrl, { type: "svg", margin: 4, errorCorrectionLevel: "H", color: { dark: "#181816", light: "#FFFFFF" } });
      return reply.type("image/svg+xml").header("Content-Disposition", 'attachment; filename="svadba-qr.svg"').send(svg);
    }
    const png = await QRCode.toBuffer(config.publicUrl, { width: 2400, margin: 4, errorCorrectionLevel: "H", color: { dark: "#181816", light: "#FFFFFF" } });
    return reply.type("image/png").header("Content-Disposition", 'attachment; filename="svadba-qr.png"').send(png);
  });
  return app;
}

function friendlyName(media: Media) {
  const guest = media.guest_name.normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 50) || "Гость";
  const date = media.created_at.slice(0, 19).replaceAll(":", "-");
  const original = path.basename(media.original_name).replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(-100);
  return `${guest}_${date}_${media.id.slice(0, 8)}_${original}`;
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sendUploadSessionError(reply: import("fastify").FastifyReply, error: unknown) {
  const status = error instanceof UploadSessionError ? error.statusCode : 500;
  return reply.code(status).header("Cache-Control", "no-store").send({ error: error instanceof Error ? error.message : "Не удалось загрузить файл" });
}

function makeGuestDeleteToken(media: Media) {
  return crypto.createHmac("sha256", config.sessionSecret).update(`${media.id}:${media.upload_id}`).digest("base64url");
}

if (process.env.NODE_ENV !== "test") {
  const app = buildApp();
  const close = async (signal: string) => { app.log.info({ signal }, "shutdown"); await app.close(); process.exit(0); };
  process.on("SIGINT", () => void close("SIGINT"));
  process.on("SIGTERM", () => void close("SIGTERM"));
  app.listen({ host: config.host, port: config.port }).catch((error) => { app.log.error(error); process.exit(1); });
}
