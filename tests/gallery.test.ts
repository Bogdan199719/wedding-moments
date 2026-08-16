import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.DATA_DIR = "./data-gallery-test";
process.env.ADMIN_PASSWORD_HASH = "scrypt:885292c00cdebe4818a395c6b828d7ea:0389157f95e2f8dc6a391f3b0dbe4099e67fa51e4a5d3d69f3d3dca69c36c0e16175322ff6f10f2decc16a3a74b4302260111f4a10cf37a46c4ce01b5e3f4b2f";

const { buildApp } = await import("../src/server.js");
const { db, uploadsDir } = await import("../src/db.js");

test("public gallery is admin-controlled, paginated and serves safe ranged media", async () => {
  const app = buildApp();
  db.prepare("UPDATE app_settings SET value='0' WHERE key='gallery_enabled'").run();
  db.prepare("DELETE FROM media").run();

  const page = await app.inject({ method: "GET", url: "/gallery" });
  assert.equal(page.statusCode, 200);
  assert.equal(page.headers["cache-control"], "no-store");
  assert.match(page.body, /Наш день/);

  assert.equal((await app.inject({ method: "GET", url: "/api/admin/gallery" })).statusCode, 401);
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/gallery", payload: { enabled: true } })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/api/gallery" })).statusCode, 404);

  const login = await app.inject({
    method: "POST", url: "/api/admin/login",
    payload: { username: "admin", password: "Wedding-Test-Password" },
  });
  const setCookie = login.headers["set-cookie"];
  const cookie = Array.isArray(setCookie) ? setCookie[0]! : String(setCookie);
  const adminHeaders = { cookie };
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/admin/gallery", headers: adminHeaders })).json(), { enabled: false, url: "/gallery" });
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/gallery", headers: adminHeaders, payload: { enabled: "yes" } })).statusCode, 400);
  assert.deepEqual((await app.inject({ method: "PUT", url: "/api/admin/gallery", headers: adminHeaders, payload: { enabled: true } })).json(), { enabled: true, url: "/gallery" });

  const photoId = crypto.randomUUID();
  const videoId = crypto.randomUUID();
  const hiddenId = crypto.randomUUID();
  const photoBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const videoBytes = Buffer.from("0123456789");
  await fsp.writeFile(path.join(uploadsDir, `${photoId}.png`), photoBytes);
  await fsp.writeFile(path.join(uploadsDir, `${videoId}.mp4`), videoBytes);
  await fsp.writeFile(path.join(uploadsDir, `${hiddenId}.png`), photoBytes);
  const insert = db.prepare(`INSERT INTO media
    (id,upload_id,original_name,stored_name,size,mime,media_type,sha256,status,created_at,guest_name,delete_token_hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  insert.run(photoId, crypto.randomUUID(), "private-camera-name.png", `${photoId}.png`, photoBytes.length, "image/png", "photo", "a".repeat(64), "ready", "2030-01-02T12:00:00.000Z", "Гость один", "secret-delete-hash");
  insert.run(videoId, crypto.randomUUID(), "private-video.mp4", `${videoId}.mp4`, videoBytes.length, "video/mp4", "video", "b".repeat(64), "ready", "2030-01-02T11:00:00.000Z", "Гость два", "another-secret");
  insert.run(hiddenId, crypto.randomUUID(), "processing.png", `${hiddenId}.png`, photoBytes.length, "image/png", "photo", "c".repeat(64), "processing", "2030-01-02T13:00:00.000Z", "Скрытый", "hidden-secret");

  const first = await app.inject({ method: "GET", url: "/api/gallery?limit=1" });
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers["cache-control"], "no-store");
  const firstPage = first.json() as { enabled: boolean; items: Array<Record<string, unknown>>; nextCursor: string };
  assert.equal(firstPage.enabled, true);
  assert.equal(firstPage.items.length, 1);
  assert.equal(firstPage.items[0]?.id, photoId);
  assert.equal(firstPage.items[0]?.url, `/api/gallery/display/${photoId}`);
  assert.equal(firstPage.items[0]?.thumbnailUrl, `/api/gallery/thumb/${photoId}`);
  for (const privateField of ["guestName", "original_name", "originalName", "stored_name", "storedName", "sha256", "deleteToken", "delete_token_hash", "upload_id"]) {
    assert.equal(privateField in firstPage.items[0]!, false);
  }
  const second = await app.inject({ method: "GET", url: `/api/gallery?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}` });
  assert.equal(second.json().items[0].id, videoId);
  assert.equal(second.json().nextCursor, null);
  assert.equal((await app.inject({ method: "GET", url: "/api/gallery?cursor=broken" })).statusCode, 400);

  const range = await app.inject({ method: "GET", url: `/api/gallery/media/${videoId}`, headers: { range: "bytes=2-5" } });
  assert.equal(range.statusCode, 206);
  assert.equal(range.body, "2345");
  assert.equal(range.headers["content-range"], "bytes 2-5/10");
  assert.equal(range.headers["accept-ranges"], "bytes");
  assert.equal((await app.inject({ method: "GET", url: `/api/gallery/media/${videoId}`, headers: { range: "bytes=99-100" } })).statusCode, 416);
  const head = await app.inject({ method: "HEAD", url: `/api/gallery/media/${videoId}` });
  assert.equal(head.statusCode, 200);
  assert.equal(head.headers["content-length"], "10");
  assert.equal(head.body, "");

  const thumbnail = await app.inject({ method: "GET", url: `/api/gallery/thumb/${photoId}` });
  assert.equal(thumbnail.statusCode, 200);
  assert.equal(thumbnail.headers["content-type"], "image/webp");
  assert.equal(thumbnail.rawPayload.subarray(0, 4).toString("ascii"), "RIFF");
  const display = await app.inject({ method: "GET", url: `/api/gallery/display/${photoId}` });
  assert.equal(display.statusCode, 200);
  assert.equal(display.headers["content-type"], "image/webp");
  assert.equal((await app.inject({ method: "GET", url: `/api/gallery/media/${photoId}` })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: `/api/gallery/media/${hiddenId}` })).statusCode, 404);

  await app.inject({ method: "PUT", url: "/api/admin/gallery", headers: adminHeaders, payload: { enabled: false } });
  assert.equal((await app.inject({ method: "GET", url: "/api/gallery" })).statusCode, 404);
  assert.equal((await app.inject({ method: "HEAD", url: `/api/gallery/media/${videoId}` })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: `/api/gallery/thumb/${photoId}` })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: `/api/gallery/display/${photoId}` })).statusCode, 404);
  await app.close();
});
