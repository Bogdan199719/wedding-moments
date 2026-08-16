import crypto from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { db, uploadsDir, type Media } from "./db.js";

export class BulkDeleteError extends Error {
  constructor(message: string, public statusCode = 400) { super(message); }
}

export async function deleteAllMedia(expectedCount: number) {
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 1) {
    throw new BulkDeleteError("Некорректное ожидаемое количество файлов");
  }
  const media = db.prepare("SELECT * FROM media ORDER BY id").all() as Media[];
  if (media.length !== expectedCount) {
    throw new BulkDeleteError("Количество файлов изменилось. Обновите страницу и повторите подтверждение.", 409);
  }

  const trashDir = path.join(config.dataDir, "bulk-delete", crypto.randomUUID());
  await fsp.mkdir(trashDir, { recursive: true, mode: 0o700 });
  const moved: Array<{ source: string; temporary: string }> = [];
  try {
    for (const item of media) {
      if (!item.stored_name || path.basename(item.stored_name) !== item.stored_name) {
        throw new BulkDeleteError("Обнаружено некорректное имя хранимого файла", 500);
      }
      const source = path.join(uploadsDir, item.stored_name);
      const temporary = path.join(trashDir, item.stored_name);
      try {
        await fsp.rename(source, temporary);
        moved.push({ source, temporary });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    const removeRows = db.transaction((ids: string[]) => {
      const removeSession = db.prepare("DELETE FROM upload_sessions WHERE completed_media_id=?");
      const removeMedia = db.prepare("DELETE FROM media WHERE id=?");
      for (const id of ids) {
        removeSession.run(id);
        removeMedia.run(id);
      }
    });
    removeRows(media.map((item) => item.id));
  } catch (error) {
    for (const item of moved.reverse()) {
      await fsp.rename(item.temporary, item.source).catch(() => undefined);
    }
    await fsp.rm(trashDir, { recursive: true, force: true });
    throw error;
  }

  await Promise.allSettled([
    fsp.rm(trashDir, { recursive: true, force: true }),
    removeGalleryRenditions(new Set(media.map((item) => item.id))),
  ]);
  return media.length;
}

async function removeGalleryRenditions(ids: Set<string>) {
  const directory = path.join(config.dataDir, "gallery-thumbnails");
  const entries = await fsp.readdir(directory).catch(() => [] as string[]);
  await Promise.all(entries.filter((name) => ids.has(name.slice(0, 36))).map((name) => fsp.rm(path.join(directory, name), { force: true })));
}
