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

function isAllowedCastOrigin(origin) {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === "discordsays.com" || host.endsWith(".discordsays.com") || host === "localhost" || host === "127.0.0.1";
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

const rendererPatch = String.raw`
(() => {
  if (globalThis.__harborFullscreenPatch) return;
  globalThis.__harborFullscreenPatch = { version: 4, patchedFrames: 0 };
  const CAST_REQUEST = "TRANSPORTE_CHROMECAST_REQUEST";
  const CAST_RESPONSE = "TRANSPORTE_CHROMECAST_RESPONSE";
  const CAST_RELAY_REQUEST = "TRANSPORTE_CHROMECAST_RELAY_REQUEST";
  const CAST_RELAY_RESPONSE = "TRANSPORTE_CHROMECAST_RELAY_RESPONSE";
  const castRequestSources = new Map();
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
  console.info("[Harbor Fullscreen Patch] Fullscreen habilitado");
})();
`;

void webFrame.executeJavaScript(rendererPatch, true).then(
  () => log("preload:renderer-injected"),
  (error) => log("preload:renderer-injection-failed", error),
);
