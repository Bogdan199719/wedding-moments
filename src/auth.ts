import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { db } from "./db.js";

const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
export function makePasswordHash(password: string, salt = crypto.randomBytes(16).toString("hex")) {
  const digest = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${digest}`;
}
export function verifyPassword(password: string, encoded: string) {
  const [, salt, expected] = encoded.split(":");
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const wanted = Buffer.from(expected, "hex");
  return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
}
export function createSession(reply: FastifyReply) {
  db.prepare("DELETE FROM sessions WHERE expires_at<=?").run(Date.now());
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = Date.now() + 8 * 60 * 60 * 1000;
  db.prepare("INSERT INTO sessions(token_hash, expires_at) VALUES (?, ?)").run(hash(token), expires);
  reply.setCookie("wedding_admin", token, {
    path: "/", httpOnly: true, secure: config.production, sameSite: "strict", maxAge: 28800,
  });
}
export function isAdmin(request: FastifyRequest) {
  const token = request.cookies.wedding_admin;
  if (!token) return false;
  return !!db.prepare("SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?")
    .get(hash(token), Date.now());
}
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (!isAdmin(request)) return reply.code(401).send({ error: "Требуется вход" });
}
export function logout(request: FastifyRequest, reply: FastifyReply) {
  const token = request.cookies.wedding_admin;
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(hash(token));
  reply.clearCookie("wedding_admin", { path: "/" });
  reply.clearCookie("wedding_admin", { path: "/admin" });
}
