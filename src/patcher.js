"use strict";

const electron = require("electron");
const fs = require("fs");
const path = require("path");
const { ipcMain } = electron;
const { HarborChromecastBridge } = require("./cast-bridge.js");

const PATCH_NAME = "Harbor Fullscreen Patch";
const installRoot = path.join(
  process.env.APPDATA || __dirname,
  "TransporteFullscreenPatch",
);

function log(message, error) {
  try {
    const file = path.join(installRoot, "patch.log");
    const suffix = error ? ` ${error?.stack || String(error)}` : "";
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}${suffix}\n`);
  } catch {}
}

log("patcher:start");

function resolveDiscordIconPath() {
  const markerPath = path.join(installRoot, "discord-icon-current.txt");
  try {
    const iconName = path.basename(fs.readFileSync(markerPath, "utf8").trim());
    const versionedPath = path.join(installRoot, iconName);
    if (/^discord-app-[\w.-]+\.ico$/i.test(iconName) && fs.existsSync(versionedPath)) {
      return versionedPath;
    }
  } catch {}
  return path.join(installRoot, "discord.ico");
}

const discordIconPath = resolveDiscordIconPath();
const chromecastBridge = new HarborChromecastBridge();

ipcMain.removeHandler("harbor-cast:request");
ipcMain.handle("harbor-cast:request", async (_event, request) => {
  const action = typeof request?.action === "string" ? request.action : "";
  return chromecastBridge.command(action, request?.payload);
});

// Prevent the custom Electron runtime from appearing as "Electron" in the
// Windows volume mixer and other shell surfaces.
electron.app.setName("Discord");
if (process.platform === "win32") {
  electron.app.setAppUserModelId("com.squirrel.Discord.Discord");
}

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
      JSON.stringify({ name: PATCH_NAME, version: 2 }, null, 2),
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
    if (options && fs.existsSync(discordIconPath)) {
      // The custom AC3 runtime is an Electron executable, whose embedded icon
      // is Electron's. Force Discord's original icon on every native window.
      options.icon = discordIconPath;
    }
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

electron.app.on("before-quit", () => {
  patchPendingDiscordUpdate();
  void chromecastBridge.close();
});
const updateWatcher = setInterval(patchPendingDiscordUpdate, 30_000);
updateWatcher.unref();

electron.app.setAppPath(originalAsar);
require.main.filename = originalEntry;
try {
  require(originalEntry);
} finally {
  process.env.HARBOR_FULLSCREEN_LOADER = originalMainFile;
}

