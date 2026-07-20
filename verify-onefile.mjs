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
if (!payload["patcher.js"].includes("--wid=${hwnd}") || !payload["preload.js"].includes("harbor-mpv-open")) {
  throw new Error("a ponte MPV embutida não está presente");
}
if (!payload["patcher.js"].includes('path.join(__dirname, "mpv", "mpv.exe")')) {
  throw new Error("o MPV instalado junto do plugin nao e priorizado");
}
if (!payload["patcher.js"].includes('"--demuxer-max-bytes=16MiB"') ||
    !payload["patcher.js"].includes("waitForMpvAudio")) {
  throw new Error("o MPV nao limita o readahead ou nao confirma a faixa de audio");
}
if (!installer.includes("AE329F16BCD9CF6C9F86D64E7977F957FB3FDAA2527451572F55C2039A369BFF") ||
    !installer.includes("Expand-Archive -LiteralPath $mpvZip")) {
  throw new Error("o download verificado do MPV nao esta presente");
}
console.log("Instalador validado: fullscreen + pontes VLC/MPV seguras.");
