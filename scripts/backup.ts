import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../src/config.js";
const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\..+/, "");
const target = path.resolve("backups", stamp);
await fs.mkdir(path.dirname(target), { recursive: true });
await fs.cp(config.dataDir, target, { recursive: true });
console.log(`Резервная копия: ${target}`);
