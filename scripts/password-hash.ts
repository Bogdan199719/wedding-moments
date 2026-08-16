import { makePasswordHash } from "../src/auth.js";
const password = process.argv[2];
if (!password || password.length < 12) throw new Error("Передайте пароль длиной не менее 12 символов");
console.log(makePasswordHash(password));
