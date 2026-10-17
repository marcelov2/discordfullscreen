"use strict";

const { ipcRenderer, webFrame } = require("electron");
const fs = require("fs");
const path = require("path");

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

const CAST_REQUEST = "TRANSPORTE_CHROMECAST_REQUEST";
const CAST_RESPONSE = "TRANSPORTE_CHROMECAST_RESPONSE";
const CAST_RELAY_REQUEST = "TRANSPORTE_CHROMECAST_RELAY_REQUEST";
const CAST_RELAY_RESPONSE = "TRANSPORTE_CHROMECAST_RELAY_RESPONSE";
const SCREEN_CAPTURE_PREPARE_REQUEST = "TRANSPORTE_SCREEN_CAPTURE_PREPARE_REQUEST";
const SCREEN_CAPTURE_REQUEST = "TRANSPORTE_SCREEN_CAPTURE_REQUEST";
const SCREEN_CAPTURE_RESPONSE = "TRANSPORTE_SCREEN_CAPTURE_RESPONSE";
const SCREEN_CAPTURE_RELAY_REQUEST = "TRANSPORTE_SCREEN_CAPTURE_RELAY_REQUEST";
const SCREEN_CAPTURE_RELAY_RESPONSE = "TRANSPORTE_SCREEN_CAPTURE_RELAY_RESPONSE";
let screenCapturePreparePromise = null;

document.addEventListener(SCREEN_CAPTURE_PREPARE_REQUEST, () => {
  if (screenCapturePreparePromise) return;
  screenCapturePreparePromise = ipcRenderer.invoke("harbor-screen-capture:prepare").then(
    (enabled) => log(`display-capture:prepare-result ${Boolean(enabled)}`),
    (error) => {
      screenCapturePreparePromise = null;
      log("display-capture:prepare-failed", error);
    },
  );
});

function isAllowedCastOrigin(origin) {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === "discordsays.com" || host.endsWith(".discordsays.com") || host === "localhost" || host === "127.0.0.1";
  } catch {
    return false;
  }
}

function isHarborCaptureOrigin(origin) {
  try {
    return new URL(origin).hostname.toLowerCase() === "1519931991066279956.discordsays.com";
  } catch {
    return false;
  }
}

document.addEventListener(CAST_RELAY_REQUEST, (event) => {
  let message;
  try {
    message = JSON.parse(event.detail);
  } catch {
    return;
  }
  if (!message || typeof message.requestId !== "string" || !isAllowedCastOrigin(message.origin)) return;
  void ipcRenderer.invoke("harbor-cast:request", {
    action: message.action,
    payload: message.payload,
  }).then(
    (result) => document.dispatchEvent(new CustomEvent(CAST_RELAY_RESPONSE, {
      detail: JSON.stringify({ requestId: message.requestId, ok: true, result }),
    })),
    (error) => document.dispatchEvent(new CustomEvent(CAST_RELAY_RESPONSE, {
      detail: JSON.stringify({ requestId: message.requestId, ok: false, error: error?.message || String(error) }),
    })),
  );
});

document.addEventListener(SCREEN_CAPTURE_RELAY_REQUEST, (event) => {
  let message;
  try {
    message = JSON.parse(event.detail);
  } catch {
    return;
  }
  if (!message || typeof message.requestId !== "string" || !isHarborCaptureOrigin(message.origin)) return;
  log(`display-capture:relay action=${message.action} origin=${message.origin}`);
  void ipcRenderer.invoke("harbor-screen-capture:request", {
    action: message.action,
    payload: message.payload,
  }).then(
    (result) => document.dispatchEvent(new CustomEvent(SCREEN_CAPTURE_RELAY_RESPONSE, {
      detail: JSON.stringify({ requestId: message.requestId, ok: true, result }),
    })),
    (error) => {
      log("display-capture:relay-failed", error);
      document.dispatchEvent(new CustomEvent(SCREEN_CAPTURE_RELAY_RESPONSE, {
        detail: JSON.stringify({ requestId: message.requestId, ok: false, error: error?.message || String(error) }),
      }));
    },
  );
});

const rendererPatch = String.raw`
(() => {
  if (globalThis.__harborFullscreenPatch) return;
  globalThis.__harborFullscreenPatch = { version: 6, patchedFrames: 0 };
  const CAST_REQUEST = "TRANSPORTE_CHROMECAST_REQUEST";
  const CAST_RESPONSE = "TRANSPORTE_CHROMECAST_RESPONSE";
  const CAST_RELAY_REQUEST = "TRANSPORTE_CHROMECAST_RELAY_REQUEST";
  const CAST_RELAY_RESPONSE = "TRANSPORTE_CHROMECAST_RELAY_RESPONSE";
  const SCREEN_CAPTURE_PREPARE_REQUEST = "TRANSPORTE_SCREEN_CAPTURE_PREPARE_REQUEST";
  const SCREEN_CAPTURE_REQUEST = "TRANSPORTE_SCREEN_CAPTURE_REQUEST";
  const SCREEN_CAPTURE_RESPONSE = "TRANSPORTE_SCREEN_CAPTURE_RESPONSE";
  const SCREEN_CAPTURE_RELAY_REQUEST = "TRANSPORTE_SCREEN_CAPTURE_RELAY_REQUEST";
  const SCREEN_CAPTURE_RELAY_RESPONSE = "TRANSPORTE_SCREEN_CAPTURE_RELAY_RESPONSE";
  const castRequestSources = new Map();
  const screenCaptureRequestSources = new Map();
  const setAttribute = Element.prototype.setAttribute;
  const getAttribute = Element.prototype.getAttribute;
  const createElement = Document.prototype.createElement;
  const activityFrames = new WeakSet();
  function isActivity(value) {
    if (!value) return false;
    try {
      const host = new URL(String(value), location.href).hostname.toLowerCase();
      return host === "discordsays.com" || host.endsWith(".discordsays.com");
    } catch { return false; }
  }
  function isHarborCaptureOrigin(value) {
    try {
      return new URL(String(value), location.href).hostname.toLowerCase() === "1519931991066279956.discordsays.com";
    } catch { return false; }
  }
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || message.type !== CAST_REQUEST || typeof message.requestId !== "string") return;
    if (!isActivity(event.origin) || !event.source || typeof event.source.postMessage !== "function") return;
    castRequestSources.set(message.requestId, { source: event.source, origin: event.origin });
    document.dispatchEvent(new CustomEvent(CAST_RELAY_REQUEST, {
      detail: JSON.stringify({
        requestId: message.requestId,
        action: message.action,
        payload: message.payload,
        origin: event.origin,
      }),
    }));
  });
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || message.type !== SCREEN_CAPTURE_REQUEST || typeof message.requestId !== "string") return;
    if (!isHarborCaptureOrigin(event.origin) || !event.source || typeof event.source.postMessage !== "function") return;
    screenCaptureRequestSources.set(message.requestId, { source: event.source, origin: event.origin });
    document.dispatchEvent(new CustomEvent(SCREEN_CAPTURE_RELAY_REQUEST, {
      detail: JSON.stringify({
        requestId: message.requestId,
        action: message.action,
        payload: message.payload,
        origin: event.origin,
      }),
    }));
  });
  document.addEventListener(CAST_RELAY_RESPONSE, (event) => {
    let message;
    try {
      message = JSON.parse(event.detail);
    } catch {
      return;
    }
    const pending = castRequestSources.get(message?.requestId);
    if (!pending) return;
    castRequestSources.delete(message.requestId);
    pending.source.postMessage({ type: CAST_RESPONSE, ...message }, pending.origin);
  });
  document.addEventListener(SCREEN_CAPTURE_RELAY_RESPONSE, (event) => {
    let message;
    try {
      message = JSON.parse(event.detail);
    } catch {
      return;
    }
    const pending = screenCaptureRequestSources.get(message?.requestId);
    if (!pending) return;
    screenCaptureRequestSources.delete(message.requestId);
    pending.source.postMessage({ type: SCREEN_CAPTURE_RESPONSE, ...message }, pending.origin);
  });
  function capturePolicy(value) {
    let current = String(value || "");
    const appendPolicy = (feature) => {
      if (new RegExp("(^|;)\\s*" + feature + "(?:\\s|;|$)", "i").test(current)) return;
      current = current ? current.replace(/\s*;?\s*$/, "; ") + feature + " *" : feature + " *";
    };
    appendPolicy("fullscreen");
    appendPolicy("display-capture");
    // Electron's desktop-capture constraints travel through getUserMedia,
    // which Chromium gates behind the camera/microphone iframe policies even
    // though no physical camera is opened.
    appendPolicy("camera");
    appendPolicy("microphone");
    return current;
  }
  function grant(frame) {
    if (!(frame instanceof HTMLIFrameElement)) return;
    activityFrames.add(frame);
    const current = capturePolicy(getAttribute.call(frame, "allow"));
    setAttribute.call(frame, "allow", current);
    setAttribute.call(frame, "allowfullscreen", "true");
    frame.allowFullscreen = true;
    globalThis.__harborFullscreenPatch.patchedFrames += 1;
    document.dispatchEvent(new CustomEvent(SCREEN_CAPTURE_PREPARE_REQUEST));
  }
  function inspect(frame, candidate) {
    if (!(frame instanceof HTMLIFrameElement)) return;
    if (isActivity(candidate || getAttribute.call(frame, "src") || frame.src)) grant(frame);
  }
  Element.prototype.setAttribute = function(name, value) {
    const normalizedName = String(name).toLowerCase();
    if (this instanceof HTMLIFrameElement && normalizedName === "src" && isActivity(value)) grant(this);
    if (this instanceof HTMLIFrameElement && normalizedName === "allow" && activityFrames.has(this)) {
      return setAttribute.call(this, name, capturePolicy(value));
    }
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
  const allowDescriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "allow");
  if (allowDescriptor?.get && allowDescriptor?.set) {
    Object.defineProperty(HTMLIFrameElement.prototype, "allow", {
      configurable: allowDescriptor.configurable,
      enumerable: allowDescriptor.enumerable,
      get: allowDescriptor.get,
      set(value) {
        return allowDescriptor.set.call(this, activityFrames.has(this) ? capturePolicy(value) : value);
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
  console.info("[Harbor Fullscreen Patch] Fullscreen e captura de tela habilitados (v6)");
})();
`;

void webFrame.executeJavaScript(rendererPatch, true).then(
  () => log("preload:renderer-injected"),
  (error) => log("preload:renderer-injection-failed", error),
);
