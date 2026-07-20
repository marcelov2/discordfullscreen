import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const installer = fs.readFileSync(path.join(root, "install-onefile.ps1"), "utf8");
const match = installer.match(/\$payloadBase64 = '([^']+)'/u);
if (!match) throw new Error("payloadBase64 não encontrado");
const payload = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));

for (const file of ["patcher.js", "preload.js"]) {
  const source = fs.readFileSync(path.join(root, "src", file), "utf8");
  if (payload[file] !== source) throw new Error(`${file} não corresponde ao instalador`);
  new vm.Script(payload[file], { filename: file });
}
if (!payload["preload.js"].includes("https://1519931991066279956.discordsays.com")) {
  throw new Error("a ponte VLC não está restrita à Activity do TRANSPORTE");
}
if (!payload["patcher.js"].includes('shell: false')) {
  throw new Error("a abertura do VLC deve continuar sem shell");
}
console.log("Instalador validado: fullscreen + ponte VLC segura.");
