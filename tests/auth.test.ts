import test from "node:test";
import assert from "node:assert/strict";
import { makePasswordHash, verifyPassword } from "../src/auth.js";
test("scrypt password hash verifies only the correct password", () => {
  const encoded = makePasswordHash("very-secure-test-password");
  assert.equal(verifyPassword("very-secure-test-password", encoded), true);
  assert.equal(verifyPassword("wrong", encoded), false);
  assert.equal(encoded.includes("very-secure-test-password"), false);
});
