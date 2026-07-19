"use strict";

const electron = require("electron");
const fs = require("fs");
const path = require("path");

const PATCH_NAME = "Harbor Fullscreen Patch";
const BRIDGE_PREFIX = "__HARBOR_REMOTE_PLAY_BRIDGE__:";
const RESULT_PREFIX = "__HARBOR_REMOTE_PLAY_RESULT__:";
const ALLOWED_REMOTE_HOSTS = new Set(["harbor.petibia.com.br", "localhost", "127.0.0.1"]);
const logFile = path.join(process.env.APPDATA || __dirname, "HarborFullscreenPatch", "patch.log");
const activityPatchSource = fs.readFileSync(path.join(__dirname, "activity-patch.js"), "utf8");
const activityContents = new Set();
const remoteSessions = new Map();

function log(message, error) {
  const suffix = error ? ` ${error?.stack || String(error)}` : "";
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}${suffix}\n`);
  } catch {}
}
function decodeBridgePayload(message, prefix) {
  if (typeof message !== "string" || !message.startsWith(prefix)) return null;
  try { return JSON.parse(Buffer.from(message.slice(prefix.length), "base64url").toString("utf8")); } catch { return null; }
}
function consoleText(args) {
  if (typeof args[0]?.message === "string") return args[0].message;
  if (typeof args[1] === "string") return args[1];
  return "";
}
function isDiscordActivityUrl(value) {
  try {
    const host = new URL(String(value)).hostname.toLowerCase();
    return host === "discordsays.com" || host.endsWith(".discordsays.com");
  } catch { return false; }
}
function validRemoteUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:"
      && ALLOWED_REMOTE_HOSTS.has(url.hostname.toLowerCase())
      && url.pathname === "/remote-play/harbor-player.html"
      && url.searchParams.get("native_bridge") === "1";
  } catch { return false; }
}
function injectActivityPatch(frame) {
  if (!frame || frame.detached || !isDiscordActivityUrl(frame.url)) return;
  void frame.executeJavaScript(activityPatchSource, true).catch((error) => log(`activity:injection-failed ${frame.url}`, error));
}
function inspectActivityFrames(contents) {
  try { for (const frame of contents.mainFrame.framesInSubtree) injectActivityPatch(frame); } catch (error) { log("activity:frame-scan-failed", error); }
}
function broadcastToActivity(session, data) {
  const script = `globalThis.__harborRemotePlayBridge?.deliver(${JSON.stringify(session)}, ${JSON.stringify(data)});`;
  for (const contents of activityContents) {
    if (contents.isDestroyed()) continue;
    try {
      for (const frame of contents.mainFrame.framesInSubtree) {
        if (isDiscordActivityUrl(frame.url)) void frame.executeJavaScript(script, true).catch(() => {});
      }
    } catch {}
  }
}
function closeRemoteSession(session, notify = true) {
  const entry = remoteSessions.get(session);
  if (!entry) return;
  remoteSessions.delete(session);
  if (!entry.window.isDestroyed()) entry.window.close();
  if (notify) broadcastToActivity(session, { type: "closed" });
}
function openRemoteSession(request, sourceContents) {
  const session = String(request.session || "").slice(0, 96);
  if (!session || !validRemoteUrl(request.url)) {
    broadcastToActivity(session, { type: "error", message: "URL nativa do Harbor recusada." });
    return;
  }
  closeRemoteSession(session, false);
  const parent = electron.BrowserWindow.fromWebContents(sourceContents) || undefined;
  const parentBounds = parent?.getBounds();
  const win = new electron.BrowserWindow({
    parent,
    width: Math.min(1280, parentBounds?.width || 1280),
    height: Math.min(800, parentBounds?.height || 800),
    minWidth: 720,
    minHeight: 480,
    title: "Harbor Together · WebRTC",
    backgroundColor: "#030407",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  remoteSessions.set(session, { window: win, sourceContents });
  win.webContents.on("console-message", (_event, ...args) => {
    const result = decodeBridgePayload(consoleText(args), RESULT_PREFIX);
    if (result?.session === session) broadcastToActivity(session, result.data);
  });
  win.webContents.on("did-finish-load", () => broadcastToActivity(session, { type: "opened" }));
  win.webContents.on("before-input-event", (event, input) => {
    if (input.key === "Escape" && input.type === "keyDown") { event.preventDefault(); closeRemoteSession(session); }
  });
  win.on("closed", () => {
    if (remoteSessions.get(session)?.window === win) {
      remoteSessions.delete(session);
      broadcastToActivity(session, { type: "closed" });
    }
  });
  void win.loadURL(request.url).catch((error) => {
    log(`bridge:load-failed ${session}`, error);
    broadcastToActivity(session, { type: "error", message: "Falha ao abrir a janela WebRTC." });
    closeRemoteSession(session, false);
  });
  log(`bridge:open ${session}`);
}
function handleBridgeRequest(request, sourceContents) {
  const session = String(request?.session || "").slice(0, 96);
  if (request?.action === "open") openRemoteSession(request, sourceContents);
  else if (request?.action === "close") closeRemoteSession(session);
  else if (request?.action === "message") {
    const entry = remoteSessions.get(session);
    if (!entry || entry.window.isDestroyed()) return;
    const script = `window.postMessage(${JSON.stringify(request.data)}, "*");`;
    void entry.window.webContents.executeJavaScript(script, true).catch((error) => log(`bridge:message-failed ${session}`, error));
  }
}

electron.app.on("web-contents-created", (_event, contents) => {
  activityContents.add(contents);
  contents.once("destroyed", () => activityContents.delete(contents));
  contents.on("console-message", (_consoleEvent, ...args) => {
    const request = decodeBridgePayload(consoleText(args), BRIDGE_PREFIX);
    if (request) handleBridgeRequest(request, contents);
  });
  contents.on("did-frame-finish-load", (_frameEvent, isMainFrame, frameProcessId, frameRoutingId) => {
    const frame = Number.isInteger(frameProcessId) && Number.isInteger(frameRoutingId)
      ? electron.webFrameMain.fromId(frameProcessId, frameRoutingId)
      : isMainFrame ? contents.mainFrame : null;
    if (frame) injectActivityPatch(frame);
    inspectActivityFrames(contents);
  });
});

function versionParts(name) { return name.replace(/^app-/, "").split(".").map((part) => Number.parseInt(part, 10) || 0); }
function isNewer(left, right) {
  const a = versionParts(left); const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0);
  }
  return false;
}
function writeLoader(resourcesDir) {
  const appAsar = path.join(resourcesDir, "app.asar"); const originalAsar = path.join(resourcesDir, "_app.asar");
  if (!fs.existsSync(appAsar) || fs.statSync(appAsar).isDirectory() || fs.existsSync(originalAsar)) return false;
  try {
    fs.renameSync(appAsar, originalAsar); fs.mkdirSync(appAsar);
    fs.writeFileSync(path.join(appAsar, "package.json"), JSON.stringify({ name: "discord", main: "index.js" }));
    fs.writeFileSync(path.join(appAsar, "index.js"), `// ${PATCH_NAME}\nrequire(${JSON.stringify(__filename)});\n`);
    fs.writeFileSync(path.join(appAsar, ".harbor-fullscreen-patch.json"), JSON.stringify({ name: PATCH_NAME, version: 2 }, null, 2));
    return true;
  } catch (error) {
    log("patch:update-failed", error);
    try { if (fs.existsSync(appAsar) && fs.statSync(appAsar).isDirectory()) fs.rmSync(appAsar, { recursive: true, force: true }); if (!fs.existsSync(appAsar) && fs.existsSync(originalAsar)) fs.renameSync(originalAsar, appAsar); } catch {}
    return false;
  }
}
function patchPendingDiscordUpdate() {
  try {
    const currentAppDir = path.dirname(process.execPath); const discordRoot = path.dirname(currentAppDir); const currentName = path.basename(currentAppDir);
    const newestName = fs.readdirSync(discordRoot).reduce((newest, candidate) => candidate.startsWith("app-") && isNewer(candidate, newest) ? candidate : newest, currentName);
    if (newestName !== currentName) writeLoader(path.join(discordRoot, newestName, "resources"));
  } catch (error) { log("patch:update-inspection-failed", error); }
}

const originalMainFile = require.main.filename;
const loaderDir = require.main.path;
const resourcesDir = path.dirname(loaderDir);
const originalAsar = path.join(resourcesDir, "_app.asar");
if (!fs.existsSync(originalAsar)) throw new Error(`${PATCH_NAME}: original Discord archive not found at ${originalAsar}`);
const originalPackage = require(path.join(originalAsar, "package.json"));
const originalEntry = path.join(originalAsar, originalPackage.main);
const OriginalBrowserWindow = electron.BrowserWindow;
class HarborPatchedBrowserWindow extends OriginalBrowserWindow {
  constructor(options) {
    if (options?.webPreferences?.preload) {
      const encodedPreload = Buffer.from(options.webPreferences.preload, "utf8").toString("base64url");
      options.webPreferences.additionalArguments = [...(options.webPreferences.additionalArguments || []), `--harbor-fullscreen-original-preload=${encodedPreload}`];
      options.webPreferences.preload = path.join(__dirname, "preload.js");
      options.webPreferences.sandbox = false;
    }
    super(options);
  }
}
Object.assign(HarborPatchedBrowserWindow, OriginalBrowserWindow);
Object.defineProperty(HarborPatchedBrowserWindow, "name", { configurable: true, value: "BrowserWindow" });
const electronModulePath = require.resolve("electron"); const electronModule = require.cache[electronModulePath];
if (!electronModule) throw new Error(`Electron module cache entry not found: ${electronModulePath}`);
const originalElectronExports = electronModule.exports; delete electronModule.exports;
electronModule.exports = { ...originalElectronExports, BrowserWindow: HarborPatchedBrowserWindow };
electron.app.on("before-quit", patchPendingDiscordUpdate);
const updateWatcher = setInterval(patchPendingDiscordUpdate, 30_000); updateWatcher.unref();
electron.app.setAppPath(originalAsar); require.main.filename = originalEntry;
try { require(originalEntry); } catch (error) { log("patcher:original-failed", error); throw error; }
process.env.HARBOR_FULLSCREEN_LOADER = originalMainFile;
