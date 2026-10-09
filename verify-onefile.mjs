import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const installer = fs.readFileSync(path.join(root, "install-onefile.ps1"), "utf8");
const match = installer.match(/\$payloadBase64 = '([^']+)'/u);
if (!match) throw new Error("payloadBase64 não encontrado");
const payload = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));

for (const file of ["patcher.js", "preload.js", "cast-bridge.js", "cast_channel.proto", "patch-common.ps1", "repair.ps1", "uninstall.ps1"]) {
  const source = fs.readFileSync(path.join(root, "src", file), "utf8");
  if (payload[file] !== source) throw new Error(`${file} não corresponde ao instalador`);
  if (file.endsWith(".js")) new vm.Script(payload[file], { filename: file });
}
if (!payload["patcher.js"].includes("HarborChromecastBridge") || !payload["preload.js"].includes("TRANSPORTE_CHROMECAST_REQUEST")) {
  throw new Error("ponte Chromecast ausente do instalador");
}
for (const forbidden of ["harbor-vlc", "harbor-mpv", "vlcBridge", "mpvBridge", "mpv.exe"]) {
  if (payload["patcher.js"].includes(forbidden) || payload["preload.js"].includes(forbidden)) {
    throw new Error(`ponte de vídeo ainda presente: ${forbidden}`);
  }
}
if (!payload["patcher.js"].includes("discordIconPath") || !payload["patcher.js"].includes("options.icon")) {
  throw new Error("correcao do icone do Discord ausente do patcher");
}
if (!payload["patcher.js"].includes("discord-icon-current.txt")) {
  throw new Error("cachebuster do icone do Discord ausente do patcher");
}
if (
  !installer.includes("Export-DiscordOriginalIcon")
  || !installer.includes("Set-DiscordShortcutIcons")
  || !installer.includes("bundledDiscordIcon")
  || !installer.includes("discordIconMarker")
) {
  throw new Error("correcao do icone do Discord ausente do instalador");
}
const hashFunction = payload["patch-common.ps1"].match(/function Test-HarborFileSha256\s*\{([\s\S]*?)\n\}/u)?.[1] || "";
const installFunction = payload["patch-common.ps1"].match(/function Install-HarborAc3RuntimeIntoApp\s*\{([\s\S]*?)\n\}/u)?.[1] || "";
if (hashFunction.includes("RceditPath")) {
  throw new Error("RceditPath foi adicionado incorretamente a Test-HarborFileSha256");
}
if (!installFunction.includes("RceditPath")) {
  throw new Error("RceditPath ausente de Install-HarborAc3RuntimeIntoApp");
}
if (!installer.includes("Update-DiscordIconCache") || !installer.includes("RceditSha256")) {
  throw new Error("atualizacao de identidade/cache ausente do instalador");
}
console.log("Instalador validado: somente fullscreen, sem VLC/MPV.");
