"use strict";

const { webFrame, ipcRenderer } = require("electron");
const fs = require("fs");
const path = require("path");

const ACTIVITY_ORIGIN = "https://1519931991066279956.discordsays.com";
const VLC_STATUS_CHANNEL = "harbor-fullscreen:vlc-status";
const VLC_OPEN_CHANNEL = "harbor-fullscreen:vlc-open";
const MPV_STATUS_CHANNEL = "harbor-fullscreen:mpv-status";
const MPV_OPEN_CHANNEL = "harbor-fullscreen:mpv-open";
const MPV_COMMAND_CHANNEL = "harbor-fullscreen:mpv-command";
const MPV_RECT_CHANNEL = "harbor-fullscreen:mpv-rect";
const MPV_CLOSE_CHANNEL = "harbor-fullscreen:mpv-close";
const MPV_VISIBILITY_CHANNEL = "harbor-fullscreen:mpv-visibility";
let activeMpvFrame = null;

function log(message, error) {
  try {
    const file = path.join(process.env.APPDATA || __dirname, "HarborFullscreenPatch", "patch.log");
    const suffix = error ? ` ${error?.stack || String(error)}` : "";
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}${suffix}\n`);
  } catch {}
}

const preloadArgument = process.argv.find((value) => value.startsWith("--harbor-fullscreen-original-preload="));
if (preloadArgument) {
  try {
    const originalPreload = Buffer.from(preloadArgument.split("=", 2)[1], "base64url").toString("utf8");
    require(originalPreload);
    log(`preload:original-loaded ${originalPreload}`);
  } catch (error) {
    log("preload:original-failed", error);
  }
}

function reply(event, payload) {
  try { event.source?.postMessage(payload, ACTIVITY_ORIGIN); } catch (error) { log("vlc:reply-failed", error); }
}

function activityFrame(event) {
  return [...document.querySelectorAll("iframe")].find((candidate) => candidate.contentWindow === event.source) || null;
}

function activityRect(event, inner) {
  const frame = activityFrame(event);
  const outer = frame?.getBoundingClientRect();
  if (!outer) return null;
  return {
    left: outer.left + Number(inner?.left || 0),
    top: outer.top + Number(inner?.top || 0),
    width: Number(inner?.width || 0),
    height: Number(inner?.height || 0),
  };
}

window.addEventListener("message", (event) => {
  if (event.origin !== ACTIVITY_ORIGIN || !event.data || typeof event.data !== "object") return;
  const requestId = typeof event.data.requestId === "string" ? event.data.requestId.slice(0, 100) : "";
  if (!requestId) return;
  if (event.data.type === "harbor-vlc-probe") {
    log("vlc:probe");
    void ipcRenderer.invoke(VLC_STATUS_CHANNEL).then(
      (result) => reply(event, { type: "harbor-vlc-status", requestId, available: result?.available === true }),
      () => reply(event, { type: "harbor-vlc-status", requestId, available: false }),
    );
  } else if (event.data.type === "harbor-vlc-open") {
    log("vlc:open-request");
    void ipcRenderer.invoke(VLC_OPEN_CHANNEL, event.data.url).then(
      (result) => reply(event, {
        type: "harbor-vlc-result",
        requestId,
        ok: result?.ok === true,
        error: typeof result?.error === "string" ? result.error : undefined,
      }),
      (error) => reply(event, {
        type: "harbor-vlc-result",
        requestId,
        ok: false,
        error: error instanceof Error ? error.message : "Falha na ponte do VLC.",
      }),
    );
  } else if (event.data.type === "harbor-mpv-probe") {
    log("mpv:probe");
    void ipcRenderer.invoke(MPV_STATUS_CHANNEL).then(
      (result) => reply(event, { type: "harbor-mpv-status", requestId, ...result }),
      () => reply(event, { type: "harbor-mpv-status", requestId, available: false }),
    );
  } else if (event.data.type === "harbor-mpv-open") {
    log("mpv:open-request");
    activeMpvFrame = activityFrame(event);
    void ipcRenderer.invoke(MPV_OPEN_CHANNEL, {
      url: event.data.url,
      audioOnly: event.data.audioOnly === true,
      rect: event.data.audioOnly === true ? null : activityRect(event, event.data.rect),
    }).then(
      (result) => reply(event, { type: "harbor-mpv-result", requestId, ...result }),
      (error) => reply(event, { type: "harbor-mpv-result", requestId, ok: false, error: String(error) }),
    );
  } else if (event.data.type === "harbor-mpv-command") {
    void ipcRenderer.invoke(MPV_COMMAND_CHANNEL, event.data.command).then(
      (result) => reply(event, { type: "harbor-mpv-result", requestId, ...result }),
      () => reply(event, { type: "harbor-mpv-result", requestId, ok: false }),
    );
  } else if (event.data.type === "harbor-mpv-rect") {
    void ipcRenderer.invoke(MPV_RECT_CHANNEL, activityRect(event, event.data.rect)).then(
      (result) => reply(event, { type: "harbor-mpv-result", requestId, ...result }),
      () => reply(event, { type: "harbor-mpv-result", requestId, ok: false }),
    );
  } else if (event.data.type === "harbor-mpv-close") {
    activeMpvFrame = null;
    void ipcRenderer.invoke(MPV_CLOSE_CHANNEL).then(
      (result) => reply(event, { type: "harbor-mpv-result", requestId, ...result }),
      () => reply(event, { type: "harbor-mpv-result", requestId, ok: false }),
    );
  } else if (event.data.type === "harbor-mpv-visibility") {
    void ipcRenderer.invoke(MPV_VISIBILITY_CHANNEL, event.data.visible === true).then(
      (result) => reply(event, { type: "harbor-mpv-result", requestId, ...result }),
      () => reply(event, { type: "harbor-mpv-result", requestId, ok: false }),
    );
  }
});

setInterval(() => {
  if (!activeMpvFrame) return;
  if (activeMpvFrame.isConnected && activeMpvFrame.src?.includes("discordsays.com")) return;
  activeMpvFrame = null;
  log("mpv:activity-closed");
  void ipcRenderer.invoke(MPV_CLOSE_CHANNEL).catch(() => {});
}, 500).unref?.();

const rendererPatch = String.raw`
(() => {
  if (globalThis.__harborFullscreenPatch) return;
  globalThis.__harborFullscreenPatch = { version: 3, patchedFrames: 0, vlcBridge: true, mpvBridge: true };
  const transporteOrigin = "https://1519931991066279956.discordsays.com";
  window.addEventListener("message", (event) => {
    if (event.origin !== transporteOrigin) return;
    if (event.data?.type?.startsWith?.("harbor-vlc-") || event.data?.type?.startsWith?.("harbor-mpv-")) {
      event.stopImmediatePropagation();
    }
  }, true);
  const setAttribute = Element.prototype.setAttribute;
  const getAttribute = Element.prototype.getAttribute;
  const createElement = Document.prototype.createElement;
  function isActivity(value) {
    if (!value) return false;
    try {
      const host = new URL(String(value), location.href).hostname.toLowerCase();
      return host === "discordsays.com" || host.endsWith(".discordsays.com");
    } catch { return false; }
  }
  function grant(frame) {
    if (!(frame instanceof HTMLIFrameElement)) return;
    const current = getAttribute.call(frame, "allow") || "";
    if (!/(^|;)\s*fullscreen(?:\s|;|$)/i.test(current)) {
      setAttribute.call(frame, "allow", current ? current.replace(/\s*;?\s*$/, "; ") + "fullscreen *" : "fullscreen *");
    }
    setAttribute.call(frame, "allowfullscreen", "true");
    frame.allowFullscreen = true;
    globalThis.__harborFullscreenPatch.patchedFrames += 1;
  }
  function inspect(frame, candidate) {
    if (!(frame instanceof HTMLIFrameElement)) return;
    if (isActivity(candidate || getAttribute.call(frame, "src") || frame.src)) grant(frame);
  }
  Element.prototype.setAttribute = function(name, value) {
    if (this instanceof HTMLIFrameElement && String(name).toLowerCase() === "src" && isActivity(value)) grant(this);
    return setAttribute.call(this, name, value);
  };
  Document.prototype.createElement = function(name, options) {
    const element = createElement.call(this, name, options);
    if (String(name).toLowerCase() === "iframe") queueMicrotask(() => inspect(element));
    return element;
  };
  const descriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "src");
  if (descriptor?.get && descriptor?.set) {
    Object.defineProperty(HTMLIFrameElement.prototype, "src", {
      configurable: descriptor.configurable,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(value) {
        if (isActivity(value)) grant(this);
        return descriptor.set.call(this, value);
      },
    });
  }
  function scan(root) {
    if (root instanceof HTMLIFrameElement) inspect(root);
    root?.querySelectorAll?.("iframe").forEach((frame) => inspect(frame));
  }
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") inspect(record.target);
      for (const node of record.addedNodes) scan(node);
    }
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
  scan(document);
  console.info("[Harbor Fullscreen Patch] Fullscreen e ponte VLC habilitados");
})();
`;

void webFrame.executeJavaScript(rendererPatch, true).then(
  () => log("preload:renderer-injected"),
  (error) => log("preload:renderer-injection-failed", error),
);
