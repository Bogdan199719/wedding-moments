import crypto from "node:crypto";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { fileTypeFromFile } from "file-type";
import { config } from "./config.js";
import { db, uploadsDir, uploadSessionsDir, type Media, type UploadSession } from "./db.js";

const allowed = new Map([
  ["image/jpeg", "jpg"], ["image/png", "png"], ["image/webp", "webp"],
  ["image/heic", "heic"], ["image/heif", "heif"], ["image/avif", "avif"],
  ["video/mp4", "mp4"], ["video/quicktime", "mov"], ["video/webm", "webm"],
]);

export class UploadSessionError extends Error {
  constructor(message: string, public statusCode = 400) { super(message); }
}

const tokenHash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
const sessionPath = (session: UploadSession) => path.join(uploadSessionsDir, session.temp_name);

function authenticate(session: UploadSession | undefined, token: string) {
  if (!session || !token) throw new UploadSessionError("Сессия загрузки не найдена", 404);
  const actual = Buffer.from(tokenHash(token));
  const expected = Buffer.from(session.token_hash);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new UploadSessionError("Сессия загрузки не найдена", 404);
  }
  if (session.expires_at <= Date.now()) throw new UploadSessionError("Сессия загрузки истекла", 410);
  return session;
}

export async function cleanupExpiredUploadSessions() {
  const expired = db.prepare("SELECT * FROM upload_sessions WHERE expires_at<=?").all(Date.now()) as UploadSession[];
  for (const session of expired) await fsp.rm(sessionPath(session), { force: true });
  db.prepare("DELETE FROM upload_sessions WHERE expires_at<=?").run(Date.now());
}

export async function createUploadSession(input: {
  sessionId: string; uploadId: string; originalName: string; declaredMime: string; expectedSize: number;
  guestName: string; clientIp: string;
}) {
  await cleanupExpiredUploadSessions();
  const guestName = input.guestName.trim().replace(/\s+/g, " ").slice(0, 80);
  const originalName = path.basename(input.originalName || "file").slice(0, 255);
  if (!guestName) throw new UploadSessionError("Укажите ваше имя");
  if (!Number.isSafeInteger(input.expectedSize) || input.expectedSize <= 0) throw new UploadSessionError("Некорректный размер файла");
  if (input.expectedSize > config.maxFileBytes) throw new UploadSessionError("Файл превышает допустимый размер", 413);
  if (!/^[0-9a-f-]{36}$/i.test(input.sessionId)) throw new UploadSessionError("Некорректный идентификатор сессии");
  if (!/^[0-9a-f-]{36}$/i.test(input.uploadId)) throw new UploadSessionError("Некорректный идентификатор загрузки");
  const id = input.sessionId;
  const token = crypto.createHmac("sha256", config.sessionSecret).update(`upload-session:${id}`).digest("base64url");
  const existing = db.prepare("SELECT * FROM upload_sessions WHERE id=?").get(id) as UploadSession | undefined;
  if (existing) {
    if (existing.upload_id !== input.uploadId || existing.expected_size !== input.expectedSize || existing.original_name !== originalName) {
      throw new UploadSessionError("Идентификатор уже используется другой загрузкой", 409);
    }
    return { session: authenticate(existing, token), token };
  }
  const activeForIp = db.prepare("SELECT COUNT(*) count FROM upload_sessions WHERE client_ip=? AND completed_media_id IS NULL AND expires_at>?").get(input.clientIp, Date.now()) as { count: number };
  if (activeForIp.count >= 12) throw new UploadSessionError("Слишком много незавершённых загрузок. Подождите минуту и попробуйте снова.", 429);
  const stat = await fsp.statfs(config.dataDir);
  const free = Number(stat.bavail) * Number(stat.bsize);
  if (free - input.expectedSize < config.minFreeBytes) throw new UploadSessionError("На сервере временно недостаточно места", 507);
  const now = Date.now();
  const session: UploadSession = {
    id, upload_id: input.uploadId, original_name: originalName, declared_mime: input.declaredMime.slice(0, 100),
    expected_size: input.expectedSize, offset: 0, temp_name: `${id}.part`, guest_name: guestName,
    token_hash: tokenHash(token), client_ip: input.clientIp, created_at: now,
    expires_at: now + config.uploadSessionTtlMs, completed_media_id: null,
  };
  await fsp.writeFile(sessionPath(session), Buffer.alloc(0), { flag: "wx", mode: 0o600 });
  db.prepare(`INSERT INTO upload_sessions(id,upload_id,original_name,declared_mime,expected_size,offset,temp_name,guest_name,token_hash,client_ip,created_at,expires_at,completed_media_id)
    VALUES(@id,@upload_id,@original_name,@declared_mime,@expected_size,@offset,@temp_name,@guest_name,@token_hash,@client_ip,@created_at,@expires_at,@completed_media_id)`).run(session);
  return { session, token };
}

export function getUploadSession(id: string, token: string) {
  return authenticate(db.prepare("SELECT * FROM upload_sessions WHERE id=?").get(id) as UploadSession | undefined, token);
}

export async function appendUploadChunk(id: string, token: string, offset: number, chunk: Buffer) {
  const session = getUploadSession(id, token);
  if (session.completed_media_id) return session;
  if (!Number.isSafeInteger(offset) || offset !== session.offset) throw new UploadSessionError("Смещение загрузки изменилось", 409);
  if (!chunk.length || chunk.length > config.uploadChunkBytes) throw new UploadSessionError("Некорректный размер части файла", 413);
  if (offset + chunk.length > session.expected_size) throw new UploadSessionError("Получено больше данных, чем ожидалось");
  const handle = await fsp.open(sessionPath(session), "r+");
  try {
    let written = 0;
    while (written < chunk.length) {
      const result = await handle.write(chunk, written, chunk.length - written, offset + written);
      written += result.bytesWritten;
    }
    await handle.sync();
  } finally { await handle.close(); }
  const nextOffset = offset + chunk.length;
  const updated = db.prepare("UPDATE upload_sessions SET offset=?,expires_at=? WHERE id=? AND offset=?").run(nextOffset, Date.now() + config.uploadSessionTtlMs, id, offset);
  if (updated.changes !== 1) {
    await fsp.truncate(sessionPath(session), offset);
    throw new UploadSessionError("Смещение загрузки изменилось", 409);
  }
  return { ...session, offset: nextOffset, expires_at: Date.now() + config.uploadSessionTtlMs };
}

async function sha256File(filename: string) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function completeUploadSession(id: string, token: string) {
  const session = getUploadSession(id, token);
  if (session.completed_media_id) {
    const existing = db.prepare("SELECT * FROM media WHERE id=?").get(session.completed_media_id) as Media | undefined;
    if (existing) return { media: existing, duplicate: true };
  }
  if (session.offset !== session.expected_size) throw new UploadSessionError("Файл загружен не полностью", 409);
  const temp = sessionPath(session);
  const stat = await fsp.stat(temp);
  if (stat.size !== session.expected_size) throw new UploadSessionError("Размер загруженного файла не совпадает");
  const detected = await fileTypeFromFile(temp);
  const ext = detected && allowed.get(detected.mime);
  if (!detected || !ext) throw new UploadSessionError("Фактический формат файла не поддерживается");
  const sha256 = await sha256File(temp);
  const duplicate = db.prepare("SELECT * FROM media WHERE sha256=? AND size=?").get(sha256, stat.size) as Media | undefined;
  if (duplicate) {
    await fsp.rm(temp, { force: true });
    db.prepare("UPDATE upload_sessions SET completed_media_id=?,expires_at=? WHERE id=?").run(duplicate.id, Date.now() + config.uploadSessionTtlMs, id);
    return { media: duplicate, duplicate: true };
  }
  const mediaId = crypto.randomUUID();
  const stored = `${mediaId}.${ext}`;
  await fsp.rename(temp, path.join(uploadsDir, stored));
  const media: Media = {
    id: mediaId, upload_id: session.upload_id, original_name: session.original_name, stored_name: stored,
    size: stat.size, mime: detected.mime, media_type: detected.mime.startsWith("image/") ? "photo" : "video",
    sha256, status: "ready", created_at: new Date().toISOString(), guest_name: session.guest_name, delete_token_hash: "",
  };
  try {
    db.prepare(`INSERT INTO media(id,upload_id,original_name,stored_name,size,mime,media_type,sha256,status,created_at,guest_name,delete_token_hash)
      VALUES(@id,@upload_id,@original_name,@stored_name,@size,@mime,@media_type,@sha256,@status,@created_at,@guest_name,@delete_token_hash)`).run(media);
    db.prepare("UPDATE upload_sessions SET completed_media_id=?,expires_at=? WHERE id=?").run(media.id, Date.now() + config.uploadSessionTtlMs, id);
  } catch (error) {
    await fsp.rm(path.join(uploadsDir, stored), { force: true });
    throw error;
  }
  return { media, duplicate: false };
}

export async function terminateUploadSession(id: string, token: string) {
  const session = getUploadSession(id, token);
  if (!session.completed_media_id) await fsp.rm(sessionPath(session), { force: true });
  db.prepare("DELETE FROM upload_sessions WHERE id=?").run(id);
}
