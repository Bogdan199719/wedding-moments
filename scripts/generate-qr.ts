import QRCode from "qrcode";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../src/config.js";

const output = path.resolve("output");
await fs.mkdir(output, { recursive: true });
await QRCode.toFile(path.join(output, "wedding-qr.png"), config.publicUrl, { width: 2400, margin: 4, errorCorrectionLevel: "H", color: { dark: "#181816", light: "#FFFFFF" } });
await fs.writeFile(path.join(output, "wedding-qr.svg"), await QRCode.toString(config.publicUrl, { type: "svg", margin: 4, errorCorrectionLevel: "H", color: { dark: "#181816", light: "#FFFFFF" } }));
await fs.writeFile(path.join(output, "sign-text.txt"), `Поделитесь моментами этого дня

Снимайте фотографии и видео или загружайте их из галереи. Все ваши кадры сохранятся в нашей общей свадебной коллекции.

Имена пары
Дата свадьбы
`);
console.log(`QR-коды созданы для ${config.publicUrl} в ${output}`);
