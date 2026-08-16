import crypto from "node:crypto";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { fileTypeFromFile } from "file-type";
import type { MultipartFile } from "@fastify/multipart";
import { pipeline } from "node:stream/promises";
import { config } from "./config.js";
import { db, uploadsDir, type Media } from "./db.js";

const allowed = new Map([
  ["image/jpeg", "jpg"], ["image/png", "png"], ["image/webp", "webp"],
  ["image/heic", "heic"], ["image/heif", "heif"], ["image/avif", "avif"],
  ["video/mp4", "mp4"], ["video/quicktime", "mov"], ["video/webm", "webm"],
]);

export type SavedUpload = { media: Media; deleteToken: string | null; duplicate: boolean };

export async function saveUpload(part: MultipartFile, uploadId: string, guestName: string): Promise<SavedUpload> {
  const id = crypto.randomUUID();
  const temp = path.join(uploadsDir, `.${id}.part`);
  const hasher = crypto.createHash("sha256");
  let size = 0;
  part.file.on("data", (chunk: Buffer) => { size += chunk.length; hasher.update(chunk); });
  try {
    await pipeline(part.file, fs.createWriteStream(temp, { flags: "wx", mode: 0o600 }));
    if (part.file.truncated || size > config.maxFileBytes) throw new Error("Файл превышает допустимый размер");
    const detected = await fileTypeFromFile(temp);
    const ext = detected && allowed.get(detected.mime);
    if (!detected || !ext) throw new Error("Фактический формат файла не поддерживается");
    const sha256 = hasher.digest("hex");
    const duplicate = db.prepare("SELECT * FROM media WHERE sha256=? AND size=?").get(sha256, size) as Media | undefined;
    if (duplicate) { await fsp.unlink(temp); return { media: duplicate, deleteToken: null, duplicate: true }; }
    const stored = `${id}.${ext}`;
    await fsp.rename(temp, path.join(uploadsDir, stored));
    const deleteToken = crypto.randomBytes(32).toString("base64url");
    const media: Media = {
      id, upload_id: uploadId, original_name: path.basename(part.filename || `file.${ext}`).slice(0, 255),
      stored_name: stored, size, mime: detected.mime,
      media_type: detected.mime.startsWith("image/") ? "photo" : "video",
      sha256, status: "ready", created_at: new Date().toISOString(),
      guest_name: guestName,
      delete_token_hash: crypto.createHash("sha256").update(deleteToken).digest("hex"),
    };
    db.prepare(`INSERT INTO media(id,upload_id,original_name,stored_name,size,mime,media_type,sha256,status,created_at,guest_name,delete_token_hash)
      VALUES(@id,@upload_id,@original_name,@stored_name,@size,@mime,@media_type,@sha256,@status,@created_at,@guest_name,@delete_token_hash)`).run(media);
    return { media, deleteToken, duplicate: false };
  } catch (error) {
    await fsp.rm(temp, { force: true });
    throw error;
  }
}
