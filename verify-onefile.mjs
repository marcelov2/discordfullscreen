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
for (const forbidden of ["harbor-vlc", "harbor-mpv", "vlcBridge", "mpvBridge", "mpv.exe"]) {
  if (payload["patcher.js"].includes(forbidden) || payload["preload.js"].includes(forbidden)) {
    throw new Error(`ponte de vídeo ainda presente: ${forbidden}`);
  }
}
console.log("Instalador validado: somente fullscreen, sem VLC/MPV.");
