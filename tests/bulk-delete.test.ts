import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.DATA_DIR = "./data-bulk-delete-test";
process.env.ADMIN_PASSWORD_HASH = "scrypt:885292c00cdebe4818a395c6b828d7ea:0389157f95e2f8dc6a391f3b0dbe4099e67fa51e4a5d3d69f3d3dca69c36c0e16175322ff6f10f2decc16a3a74b4302260111f4a10cf37a46c4ce01b5e3f4b2f";

const { buildApp } = await import("../src/server.js");
const { db, uploadsDir } = await import("../src/db.js");
const { config } = await import("../src/config.js");

test("administrator can delete the entire collection only after exact and current confirmation", async () => {
  const app = buildApp();
  db.prepare("DELETE FROM media").run();
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  const files = ids.map((id) => path.join(uploadsDir, `${id}.jpg`));
  await Promise.all(files.map((file, index) => fsp.writeFile(file, Buffer.from(`test-${index}`))));
  const insert = db.prepare(`INSERT INTO media
    (id,upload_id,original_name,stored_name,size,mime,media_type,sha256,status,created_at,guest_name,delete_token_hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  ids.forEach((id, index) => insert.run(id, crypto.randomUUID(), `photo-${index}.jpg`, `${id}.jpg`, 6, "image/jpeg", "photo", String(index).repeat(64), "ready", new Date(Date.now() + index).toISOString(), "Гость", "hash"));

  const thumbnailsDir = path.join(config.dataDir, "gallery-thumbnails");
  await fsp.mkdir(thumbnailsDir, { recursive: true });
  const thumbnail = path.join(thumbnailsDir, `${ids[0]}-${"a".repeat(16)}-thumb.webp`);
  await fsp.writeFile(thumbnail, "preview");

  assert.equal((await app.inject({ method: "DELETE", url: "/api/admin/media", payload: { confirmation: "УДАЛИТЬ ВСЕ", expectedCount: 2 } })).statusCode, 401);
  const login = await app.inject({ method: "POST", url: "/api/admin/login", payload: { username: "admin", password: "Wedding-Test-Password" } });
  const setCookie = login.headers["set-cookie"];
  const cookie = Array.isArray(setCookie) ? setCookie[0]! : String(setCookie);

  const wrongPhrase = await app.inject({ method: "DELETE", url: "/api/admin/media", headers: { cookie }, payload: { confirmation: "delete", expectedCount: 2 } });
  assert.equal(wrongPhrase.statusCode, 400);
  const staleCount = await app.inject({ method: "DELETE", url: "/api/admin/media", headers: { cookie }, payload: { confirmation: "УДАЛИТЬ ВСЕ", expectedCount: 1 } });
  assert.equal(staleCount.statusCode, 409);
  assert.equal((db.prepare("SELECT COUNT(*) count FROM media").get() as { count: number }).count, 2);

  const deleted = await app.inject({ method: "DELETE", url: "/api/admin/media", headers: { cookie }, payload: { confirmation: "УДАЛИТЬ ВСЕ", expectedCount: 2 } });
  assert.equal(deleted.statusCode, 200);
  assert.deepEqual(deleted.json(), { deleted: 2 });
  assert.equal((db.prepare("SELECT COUNT(*) count FROM media").get() as { count: number }).count, 0);
  await Promise.all(files.map((file) => assert.rejects(fsp.access(file))));
  await assert.rejects(fsp.access(thumbnail));
  await app.close();
});
