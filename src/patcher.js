"use strict";

const electron = require("electron");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const net = require("net");

const PATCH_NAME = "Harbor Fullscreen Patch";
const VLC_STATUS_CHANNEL = "harbor-fullscreen:vlc-status";
const VLC_OPEN_CHANNEL = "harbor-fullscreen:vlc-open";
const MPV_STATUS_CHANNEL = "harbor-fullscreen:mpv-status";
const MPV_OPEN_CHANNEL = "harbor-fullscreen:mpv-open";
const MPV_COMMAND_CHANNEL = "harbor-fullscreen:mpv-command";
const MPV_RECT_CHANNEL = "harbor-fullscreen:mpv-rect";
const MPV_CLOSE_CHANNEL = "harbor-fullscreen:mpv-close";

const mpvSessions = new Map();

function findOnPath(name) {
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    const candidate = path.join(dir.replace(/^"|"$/g, ""), name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findMpvExecutable() {
  const candidates = [
    process.env.HARBOR_MPV_PATH,
    findOnPath("mpv.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "mpv", "mpv.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "mpv", "mpv.exe"),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, "scoop", "apps", "mpv", "current", "mpv.exe"),
    "C:\\mpv\\mpv.exe",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function ownerForEvent(event) {
  return electron.BrowserWindow.fromWebContents(event.sender) || null;
}

function sessionKey(event) {
  return ownerForEvent(event)?.id || 0;
}

function normalizeRect(owner, raw) {
  const base = owner.getContentBounds();
  const left = Number(raw?.left);
  const top = Number(raw?.top);
  const width = Number(raw?.width);
  const height = Number(raw?.height);
  if (![left, top, width, height].every(Number.isFinite) || width < 64 || height < 64) return null;
  return {
    x: Math.round(base.x + left),
    y: Math.round(base.y + top),
    width: Math.max(64, Math.round(width)),
    height: Math.max(64, Math.round(height)),
  };
}

function closeMpvSession(key) {
  const session = mpvSessions.get(key);
  if (!session) return;
  mpvSessions.delete(key);
  try {
    for (const resolve of session.pending?.values?.() || []) resolve({ error: "closed" });
    session.pending?.clear?.();
  } catch {}
  try { session.socket?.destroy(); } catch {}
  try { session.child?.kill(); } catch {}
  try { if (!session.window?.isDestroyed()) session.window.destroy(); } catch {}
}

function connectMpvPipe(session, attempts = 40) {
  if (!mpvSessions.has(session.key)) return;
  const socket = net.createConnection(session.pipe);
  socket.setEncoding("utf8");
  socket.once("connect", () => {
    session.socket = socket;
    session.connected = true;
  });
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        const pending = session.pending.get(message.request_id);
        if (pending) {
          session.pending.delete(message.request_id);
          pending(message);
        }
      } catch {}
    }
  });
  socket.once("error", () => {
    socket.destroy();
    if (attempts > 0) setTimeout(() => connectMpvPipe(session, attempts - 1), 125);
  });
  socket.once("close", () => {
    if (session.socket === socket) {
      session.socket = null;
      session.connected = false;
    }
  });
}

function mpvCommand(session, command) {
  if (!session?.connected || !session.socket) return false;
  try {
    session.socket.write(`${JSON.stringify({ command })}\n`);
    return true;
  } catch {
    return false;
  }
}

function mpvRequest(session, command) {
  if (!session?.connected || !session.socket) return Promise.resolve({ ok: false });
  const requestId = ++session.requestId;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      session.pending.delete(requestId);
      resolve({ ok: false });
    }, 1000);
    session.pending.set(requestId, (message) => {
      clearTimeout(timer);
      resolve({ ok: message.error === "success", data: message.data });
    });
    try {
      session.socket.write(`${JSON.stringify({ command, request_id: requestId })}\n`);
    } catch {
      clearTimeout(timer);
      session.pending.delete(requestId);
      resolve({ ok: false });
    }
  });
}

function findVlcExecutable() {
  const candidates = [
    process.env.HARBOR_VLC_PATH,
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "VideoLAN", "VLC", "vlc.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "VideoLAN", "VLC", "vlc.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "VideoLAN", "VLC", "vlc.exe"),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function trustedDiscordSender(event) {
  try {
    const host = new URL(event.senderFrame?.url || "").hostname.toLowerCase();
    return host === "discord.com" || host.endsWith(".discord.com");
  } catch {
    return false;
  }
}

electron.ipcMain.removeHandler(VLC_STATUS_CHANNEL);
electron.ipcMain.handle(VLC_STATUS_CHANNEL, (event) => ({
  available: trustedDiscordSender(event) && !!findVlcExecutable(),
}));
electron.ipcMain.removeHandler(VLC_OPEN_CHANNEL);
electron.ipcMain.handle(VLC_OPEN_CHANNEL, (event, rawUrl) => {
  if (!trustedDiscordSender(event)) return { ok: false, error: "Origem não autorizada." };
  let mediaUrl;
  try {
    mediaUrl = new URL(String(rawUrl || ""));
    if (mediaUrl.protocol !== "https:" && mediaUrl.protocol !== "http:") throw new Error("protocol");
  } catch {
    return { ok: false, error: "Endereço de mídia inválido." };
  }
  const vlc = findVlcExecutable();
  if (!vlc) return { ok: false, error: "VLC não encontrado no computador." };
  try {
    const child = spawn(vlc, ["--no-qt-start-minimized", "--no-one-instance", mediaUrl.toString()], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      shell: false,
    });
    child.unref();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Falha ao iniciar o VLC." };
  }
});

electron.ipcMain.removeHandler(MPV_STATUS_CHANNEL);
electron.ipcMain.handle(MPV_STATUS_CHANNEL, (event) => ({
  available: trustedDiscordSender(event) && !!findMpvExecutable(),
  active: mpvSessions.has(sessionKey(event)),
}));

electron.ipcMain.removeHandler(MPV_OPEN_CHANNEL);
electron.ipcMain.handle(MPV_OPEN_CHANNEL, (event, payload) => {
  if (!trustedDiscordSender(event)) return { ok: false, error: "Origem não autorizada." };
  const owner = ownerForEvent(event);
  const mpv = findMpvExecutable();
  if (!owner || !mpv) return { ok: false, error: "MPV não encontrado no computador." };
  let mediaUrl;
  try {
    mediaUrl = new URL(String(payload?.url || ""));
    if (!/^https?:$/.test(mediaUrl.protocol)) throw new Error("protocol");
  } catch {
    return { ok: false, error: "Endereço de mídia inválido." };
  }
  const bounds = normalizeRect(owner, payload?.rect);
  if (!bounds) return { ok: false, error: "Área de vídeo inválida." };
  const key = owner.id;
  closeMpvSession(key);
  try {
    const surface = new electron.BrowserWindow({
      parent: owner,
      modal: false,
      frame: false,
      show: false,
      focusable: false,
      skipTaskbar: true,
      backgroundColor: "#000000",
      hasShadow: false,
      webPreferences: { sandbox: true, contextIsolation: true },
    });
    surface.setBounds(bounds);
    surface.setIgnoreMouseEvents(true);
    const hwnd = surface.getNativeWindowHandle().readUInt32LE(0);
    const pipe = `\\\\.\\pipe\\harbor-mpv-${process.pid}-${key}-${Date.now()}`;
    const args = [
      "--no-config",
      "--idle=no",
      "--force-window=yes",
      "--no-border",
      "--show-in-taskbar=no",
      "--input-default-bindings=no",
      "--osc=no",
      "--hwdec=auto-safe",
      `--wid=${hwnd}`,
      `--input-ipc-server=${pipe}`,
      mediaUrl.toString(),
    ];
    const child = spawn(mpv, args, { detached: false, stdio: "ignore", windowsHide: true, shell: false });
    const session = {
      key, owner, window: surface, child, pipe, socket: null, connected: false,
      requestId: 0, pending: new Map(),
    };
    mpvSessions.set(key, session);
    child.once("exit", () => closeMpvSession(key));
    surface.once("closed", () => closeMpvSession(key));
    owner.once("closed", () => closeMpvSession(key));
    connectMpvPipe(session);
    surface.showInactive();
    return { ok: true };
  } catch (error) {
    closeMpvSession(key);
    return { ok: false, error: error instanceof Error ? error.message : "Falha ao iniciar o MPV." };
  }
});

electron.ipcMain.removeHandler(MPV_COMMAND_CHANNEL);
electron.ipcMain.handle(MPV_COMMAND_CHANNEL, async (event, command) => {
  if (!trustedDiscordSender(event)) return { ok: false };
  const session = mpvSessions.get(sessionKey(event));
  if (!session) return { ok: false, error: "MPV não está ativo." };
  const allowed = new Set(["set_property", "get_property", "seek", "sub-add", "screenshot-to-file", "quit"]);
  if (!Array.isArray(command) || !allowed.has(String(command[0]))) return { ok: false, error: "Comando inválido." };
  if (command[0] === "get_property") return await mpvRequest(session, command);
  return { ok: mpvCommand(session, command) };
});

electron.ipcMain.removeHandler(MPV_RECT_CHANNEL);
electron.ipcMain.handle(MPV_RECT_CHANNEL, (event, rawRect) => {
  if (!trustedDiscordSender(event)) return { ok: false };
  const session = mpvSessions.get(sessionKey(event));
  const bounds = session && normalizeRect(session.owner, rawRect);
  if (!session || !bounds || session.window.isDestroyed()) return { ok: false };
  session.window.setBounds(bounds, false);
  return { ok: true };
});

electron.ipcMain.removeHandler(MPV_CLOSE_CHANNEL);
electron.ipcMain.handle(MPV_CLOSE_CHANNEL, (event) => {
  if (!trustedDiscordSender(event)) return { ok: false };
  closeMpvSession(sessionKey(event));
  return { ok: true };
});

function versionParts(name) {
  return name.replace(/^app-/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function isNewer(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0);
  }
  return false;
}

function writeLoader(resourcesDir) {
  const appAsar = path.join(resourcesDir, "app.asar");
  const originalAsar = path.join(resourcesDir, "_app.asar");
  if (!fs.existsSync(appAsar) || fs.statSync(appAsar).isDirectory() || fs.existsSync(originalAsar)) {
    return false;
  }
  try {
    fs.renameSync(appAsar, originalAsar);
    fs.mkdirSync(appAsar);
    fs.writeFileSync(
      path.join(appAsar, "package.json"),
      JSON.stringify({ name: "discord", main: "index.js" }),
    );
    fs.writeFileSync(
      path.join(appAsar, "index.js"),
      `// ${PATCH_NAME}\nrequire(${JSON.stringify(__filename)});\n`,
    );
    fs.writeFileSync(
      path.join(appAsar, ".harbor-fullscreen-patch.json"),
      JSON.stringify({ name: PATCH_NAME, version: 3 }, null, 2),
    );
    return true;
  } catch {
    try {
      if (fs.existsSync(appAsar) && fs.statSync(appAsar).isDirectory()) {
        fs.rmSync(appAsar, { recursive: true, force: true });
      }
      if (!fs.existsSync(appAsar) && fs.existsSync(originalAsar)) {
        fs.renameSync(originalAsar, appAsar);
      }
    } catch {}
    return false;
  }
}

function patchPendingDiscordUpdate() {
  try {
    const currentAppDir = path.dirname(process.execPath);
    const discordRoot = path.dirname(currentAppDir);
    const currentName = path.basename(currentAppDir);
    const newestName = fs.readdirSync(discordRoot).reduce(
      (newest, candidate) => candidate.startsWith("app-") && isNewer(candidate, newest)
        ? candidate
        : newest,
      currentName,
    );
    if (newestName !== currentName) writeLoader(path.join(discordRoot, newestName, "resources"));
  } catch {}
}

const originalMainFile = require.main.filename;
const loaderDir = require.main.path;
const resourcesDir = path.dirname(loaderDir);
const originalAsar = path.join(resourcesDir, "_app.asar");
if (!fs.existsSync(originalAsar)) {
  throw new Error(`${PATCH_NAME}: original Discord archive not found at ${originalAsar}`);
}

const originalPackage = require(path.join(originalAsar, "package.json"));
const originalEntry = path.join(originalAsar, originalPackage.main);
const OriginalBrowserWindow = electron.BrowserWindow;

class HarborPatchedBrowserWindow extends OriginalBrowserWindow {
  constructor(options) {
    if (options?.webPreferences?.preload) {
      const encodedPreload = Buffer.from(options.webPreferences.preload, "utf8").toString("base64url");
      options.webPreferences.additionalArguments = [
        ...(options.webPreferences.additionalArguments || []),
        `--harbor-fullscreen-original-preload=${encodedPreload}`,
      ];
      options.webPreferences.preload = path.join(__dirname, "preload.js");
      options.webPreferences.sandbox = false;
    }
    super(options);
  }
}

Object.assign(HarborPatchedBrowserWindow, OriginalBrowserWindow);
Object.defineProperty(HarborPatchedBrowserWindow, "name", {
  configurable: true,
  value: "BrowserWindow",
});

const electronModulePath = require.resolve("electron");
const electronModule = require.cache[electronModulePath];
if (!electronModule) throw new Error(`Electron module cache entry not found: ${electronModulePath}`);
const originalElectronExports = electronModule.exports;
delete electronModule.exports;
electronModule.exports = {
  ...originalElectronExports,
  BrowserWindow: HarborPatchedBrowserWindow,
};

electron.app.on("before-quit", patchPendingDiscordUpdate);
const updateWatcher = setInterval(patchPendingDiscordUpdate, 30_000);
updateWatcher.unref();

electron.app.setAppPath(originalAsar);
require.main.filename = originalEntry;
try {
  require(originalEntry);
} finally {
  process.env.HARBOR_FULLSCREEN_LOADER = originalMainFile;
}
