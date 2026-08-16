import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
process.env.NODE_ENV = "test";
process.env.DATA_DIR = "./data-test";
process.env.ADMIN_PASSWORD_HASH = "scrypt:885292c00cdebe4818a395c6b828d7ea:0389157f95e2f8dc6a391f3b0dbe4099e67fa51e4a5d3d69f3d3dca69c36c0e16175322ff6f10f2decc16a3a74b4302260111f4a10cf37a46c4ce01b5e3f4b2f";
const { buildApp } = await import("../src/server.js");
test("health and public page", async () => {
  const app = buildApp();
  const health = await app.inject({ method: "GET", url: "/health" });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().status, "ok");
  const page = await app.inject({ method: "GET", url: "/" });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Wedding/);
  await app.close();
});
test("admin endpoints reject anonymous users", async () => {
  const app = buildApp();
  const result = await app.inject({ method: "GET", url: "/api/admin/media" });
  assert.equal(result.statusCode, 401);
  await app.close();
});
test("administrator can sign in and receive a protected session", async () => {
  const app = buildApp();
  const login = await app.inject({ method: "POST", url: "/api/admin/login", payload: { username: "admin", password: "Wedding-Test-Password" } });
  assert.equal(login.statusCode, 200);
  const cookie = login.headers["set-cookie"];
  assert.ok(cookie);
  assert.match(Array.isArray(cookie) ? cookie[0]! : cookie, /Path=\//);
  const media = await app.inject({ method: "GET", url: "/api/admin/media", headers: { cookie: Array.isArray(cookie) ? cookie[0]! : cookie } });
  assert.equal(media.statusCode, 200);
  await app.close();
});
const multipart = (filename: string, type: string, data: Buffer, uploadId?: string) => {
  const boundary = "----wedding-test-boundary";
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="guestName"\r\n\r\nТестовый гость\r\n`),
      uploadId ? Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="uploadId"\r\n\r\n${uploadId}\r\n`) : Buffer.alloc(0),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
};
test("upload accepts a real image and deduplicates it", async () => {
  const app = buildApp();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const first = await app.inject({ method: "POST", url: "/api/uploads", ...multipart("photo.txt", "text/plain", png) });
  assert.equal(first.statusCode, 201);
  const second = await app.inject({ method: "POST", url: "/api/uploads", ...multipart("same.png", "image/png", png) });
  assert.equal(second.statusCode, 201);
  assert.equal(first.json().files[0].id, second.json().files[0].id);
  await app.close();
});
test("upload rejects executable content disguised as an image", async () => {
  const app = buildApp();
  const result = await app.inject({ method: "POST", url: "/api/uploads", ...multipart("malware.jpg", "image/jpeg", Buffer.from("MZ executable")) });
  assert.equal(result.statusCode, 400);
  assert.match(result.json().error, /формат/i);
  await app.close();
});
test("upload requires a guest name before file data", async () => {
  const app = buildApp();
  const boundary = "----missing-name-boundary";
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\n`),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const result = await app.inject({ method: "POST", url: "/api/uploads", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload });
  assert.equal(result.statusCode, 400);
  assert.match(result.json().error, /имя/i);
  await app.close();
});
test("guest can delete a newly uploaded file only with its delete token", async () => {
  const app = buildApp();
  const png = Buffer.concat([
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
    Buffer.from(crypto.randomUUID()),
  ]);
  const upload = await app.inject({ method: "POST", url: "/api/uploads", ...multipart("delete-me.png", "image/png", png) });
  assert.equal(upload.statusCode, 201);
  const file = upload.json().files[0] as { id: string; deleteToken: string };
  assert.ok(file.deleteToken);
  const rejected = await app.inject({ method: "DELETE", url: `/api/uploads/${file.id}`, headers: { "x-delete-token": "wrong-token" } });
  assert.equal(rejected.statusCode, 404);
  const removed = await app.inject({ method: "DELETE", url: `/api/uploads/${file.id}`, headers: { "x-delete-token": file.deleteToken } });
  assert.equal(removed.statusCode, 204);
  await app.close();
});
test("automatic retry is idempotent and keeps guest deletion available", async () => {
  const app = buildApp();
  const uploadId = crypto.randomUUID();
  const png = Buffer.concat([
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
    Buffer.from(crypto.randomUUID()),
  ]);
  const first = await app.inject({ method: "POST", url: "/api/uploads", ...multipart("retry.png", "image/png", png, uploadId) });
  const repeated = await app.inject({ method: "POST", url: "/api/uploads", ...multipart("retry.png", "image/png", png, uploadId) });
  assert.equal(first.statusCode, 201);
  assert.equal(repeated.statusCode, 201);
  assert.equal(repeated.json().files[0].id, first.json().files[0].id);
  assert.ok(repeated.json().files[0].deleteToken);
  const removed = await app.inject({
    method: "DELETE",
    url: `/api/uploads/${first.json().files[0].id}`,
    headers: { "x-delete-token": repeated.json().files[0].deleteToken },
  });
  assert.equal(removed.statusCode, 204);
  await app.close();
});
test("resumable upload continues from the accepted offset and completes idempotently", async () => {
  const app = buildApp();
  const sessionId = crypto.randomUUID();
  const uploadId = crypto.randomUUID();
  const png = Buffer.concat([
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
    Buffer.from(crypto.randomUUID()),
  ]);
  const creationPayload = { sessionId, uploadId, name: "resumable.png", type: "image/png", size: png.length, guestName: "Тестовый гость" };
  const created = await app.inject({ method: "POST", url: "/api/upload-sessions", payload: creationPayload });
  assert.equal(created.statusCode, 201);
  const session = created.json() as { id: string; token: string; chunkSize: number };
  assert.equal(session.id, sessionId);
  assert.ok(session.token);
  const repeatedCreation = await app.inject({ method: "POST", url: "/api/upload-sessions", payload: creationPayload });
  assert.equal(repeatedCreation.statusCode, 201);
  assert.equal(repeatedCreation.json().token, session.token);
  const split = Math.floor(png.length / 2);
  const first = await app.inject({
    method: "PATCH", url: `/api/upload-sessions/${sessionId}`,
    headers: { "content-type": "application/offset+octet-stream", "x-upload-token": session.token, "upload-offset": "0" },
    payload: png.subarray(0, split),
  });
  assert.equal(first.statusCode, 204);
  assert.equal(Number(first.headers["upload-offset"]), split);
  const stale = await app.inject({
    method: "PATCH", url: `/api/upload-sessions/${sessionId}`,
    headers: { "content-type": "application/offset+octet-stream", "x-upload-token": session.token, "upload-offset": "0" },
    payload: png.subarray(split),
  });
  assert.equal(stale.statusCode, 409);
  const status = await app.inject({ method: "HEAD", url: `/api/upload-sessions/${sessionId}`, headers: { "x-upload-token": session.token } });
  assert.equal(status.statusCode, 204);
  assert.equal(Number(status.headers["upload-offset"]), split);
  const second = await app.inject({
    method: "PATCH", url: `/api/upload-sessions/${sessionId}`,
    headers: { "content-type": "application/offset+octet-stream", "x-upload-token": session.token, "upload-offset": String(split) },
    payload: png.subarray(split),
  });
  assert.equal(second.statusCode, 204);
  assert.equal(Number(second.headers["upload-offset"]), png.length);
  const completed = await app.inject({ method: "POST", url: `/api/upload-sessions/${sessionId}/complete`, headers: { "x-upload-token": session.token } });
  assert.equal(completed.statusCode, 201);
  const result = completed.json() as { id: string; deleteToken: string };
  assert.ok(result.deleteToken);
  const completedAgain = await app.inject({ method: "POST", url: `/api/upload-sessions/${sessionId}/complete`, headers: { "x-upload-token": session.token } });
  assert.equal(completedAgain.statusCode, 201);
  assert.equal(completedAgain.json().id, result.id);
  const removed = await app.inject({ method: "DELETE", url: `/api/uploads/${result.id}`, headers: { "x-delete-token": result.deleteToken } });
  assert.equal(removed.statusCode, 204);
  await app.close();
});
test("unfinished resumable upload can be terminated", async () => {
  const app = buildApp();
  const sessionId = crypto.randomUUID();
  const created = await app.inject({
    method: "POST", url: "/api/upload-sessions",
    payload: { sessionId, uploadId: crypto.randomUUID(), name: "cancelled.mp4", type: "video/mp4", size: 100, guestName: "Гость" },
  });
  assert.equal(created.statusCode, 201);
  const token = created.json().token as string;
  const removed = await app.inject({ method: "DELETE", url: `/api/upload-sessions/${sessionId}`, headers: { "x-upload-token": token } });
  assert.equal(removed.statusCode, 204);
  const status = await app.inject({ method: "HEAD", url: `/api/upload-sessions/${sessionId}`, headers: { "x-upload-token": token } });
  assert.equal(status.statusCode, 404);
  await app.close();
});
test("administrator can generate print QR files", async () => {
  const app = buildApp();
  const login = await app.inject({ method: "POST", url: "/api/admin/login", payload: { username: "admin", password: "Wedding-Test-Password" } });
  const cookie = login.headers["set-cookie"]!;
  const header = Array.isArray(cookie) ? cookie[0]! : cookie;
  const png = await app.inject({ method: "GET", url: "/api/admin/qr?format=png", headers: { cookie: header } });
  assert.equal(png.statusCode, 200);
  assert.equal(png.headers["content-type"], "image/png");
  const svg = await app.inject({ method: "GET", url: "/api/admin/qr?format=svg", headers: { cookie: header } });
  assert.equal(svg.statusCode, 200);
  assert.match(svg.body, /<svg/);
  await app.close();
});
