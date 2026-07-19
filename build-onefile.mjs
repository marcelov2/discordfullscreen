import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const installerPath = path.join(root, "install-onefile.ps1");
const installer = fs.readFileSync(installerPath, "utf8");
const match = installer.match(/\$payloadBase64 = '([^']+)'/u);
if (!match) throw new Error("payloadBase64 não encontrado");
const payload = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
payload["patcher.js"] = fs.readFileSync(path.join(root, "src", "patcher.js"), "utf8");
payload["activity-patch.js"] = fs.readFileSync(path.join(root, "src", "activity-patch.js"), "utf8");
const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
fs.writeFileSync(installerPath, installer.replace(match[0], `$payloadBase64 = '${encoded}'`), "utf8");
console.log(`install-onefile.ps1 atualizado (${encoded.length} bytes base64)`);
