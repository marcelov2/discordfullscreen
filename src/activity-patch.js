(() => {
  "use strict";

  const BRIDGE_PREFIX = "__HARBOR_REMOTE_PLAY_BRIDGE__:";
  const bridgeListeners = new Map();
  const encode = (value) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  };
  const emit = (payload) => console.info(`${BRIDGE_PREFIX}${encode(payload)}`);

  if (!globalThis.__harborRemotePlayBridge) {
    globalThis.__harborRemotePlayBridge = Object.freeze({
      version: 1,
      open: (session, url) => emit({ action: "open", session, url }),
      send: (session, data) => emit({ action: "message", session, data }),
      close: (session) => emit({ action: "close", session }),
      subscribe: (session, listener) => {
        if (typeof listener !== "function") return () => {};
        const listeners = bridgeListeners.get(session) || new Set();
        listeners.add(listener);
        bridgeListeners.set(session, listeners);
        return () => {
          listeners.delete(listener);
          if (!listeners.size) bridgeListeners.delete(session);
        };
      },
      deliver: (session, data) => {
        for (const listener of bridgeListeners.get(session) || []) {
          try { listener(data); } catch (error) { console.error("[Harbor Remote Play Bridge] listener", error); }
        }
      },
    });
    dispatchEvent(new CustomEvent("harbor-remote-play-bridge-ready"));
    console.info("[Harbor Fullscreen Patch] Together WebRTC bridge ready");
  }

  if (globalThis.__harborAc3Patch) return;
  const ac3TypePattern = /(?:audio\/(?:x-)?(?:e?ac3)|codecs\s*=\s*["'][^"']*\b(?:ac-3|ec-3|ac3|eac3)\b)/i;
  const isAc3Type = (value) => ac3TypePattern.test(String(value || ""));
  const isActivityProxyUrl = (value) => {
    try {
      const url = new URL(String(value), location.href);
      return (url.hostname === "discordsays.com" || url.hostname.endsWith(".discordsays.com"))
        && url.pathname.includes("/activity-proxy/");
    } catch { return false; }
  };
  const nativeCanPlayType = HTMLMediaElement.prototype.canPlayType;
  HTMLMediaElement.prototype.canPlayType = function harborCanPlayType(type) {
    if (isAc3Type(type)) return "probably";
    return nativeCanPlayType.call(this, type);
  };
  const patchMediaSource = (MediaSourceClass) => {
    if (!MediaSourceClass || typeof MediaSourceClass.isTypeSupported !== "function") return;
    const nativeIsTypeSupported = MediaSourceClass.isTypeSupported.bind(MediaSourceClass);
    MediaSourceClass.isTypeSupported = (type) => isAc3Type(type) || nativeIsTypeSupported(type);
  };
  patchMediaSource(globalThis.MediaSource);
  patchMediaSource(globalThis.ManagedMediaSource);
  const nativeDecodingInfo = globalThis.navigator?.mediaCapabilities?.decodingInfo?.bind(
    globalThis.navigator.mediaCapabilities,
  );
  if (nativeDecodingInfo) {
    globalThis.navigator.mediaCapabilities.decodingInfo = async (config) => {
      const audioType = config?.audio?.contentType;
      if (isAc3Type(audioType)) {
        return { supported: true, smooth: true, powerEfficient: true };
      }
      return nativeDecodingInfo(config);
    };
  }
  const nativeFetch = globalThis.fetch?.bind(globalThis);
  if (nativeFetch) {
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : null;
      const method = String(init?.method || request?.method || "GET").toUpperCase();
      const url = request?.url || input;
      if (method !== "HEAD" || !isActivityProxyUrl(url)) return nativeFetch(input, init);
      const headers = new Headers(init?.headers || request?.headers);
      if (!headers.has("Range")) headers.set("Range", "bytes=0-0");
      const response = await nativeFetch(input, { ...init, method: "GET", headers });
      return new Response(null, {
        status: response.status === 206 ? 200 : response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };
  }
  const NativeXMLHttpRequest = globalThis.XMLHttpRequest;
  if (NativeXMLHttpRequest) {
    const nativeOpen = NativeXMLHttpRequest.prototype.open;
    const nativeSend = NativeXMLHttpRequest.prototype.send;
    NativeXMLHttpRequest.prototype.open = function harborOpen(method, url, ...rest) {
      this.__harborHeadFallback = String(method || "GET").toUpperCase() === "HEAD"
        && isActivityProxyUrl(url);
      return nativeOpen.call(this, this.__harborHeadFallback ? "GET" : method, url, ...rest);
    };
    NativeXMLHttpRequest.prototype.send = function harborSend(body) {
      if (this.__harborHeadFallback) {
        try { this.setRequestHeader("Range", "bytes=0-0"); } catch {}
      }
      return nativeSend.call(this, body);
    };
  }
  globalThis.__harborAc3SupportCheck = () => ({
    canPlayType: document.createElement("audio").canPlayType('audio/mp4; codecs="ac-3"'),
    mediaSource: Boolean(globalThis.MediaSource?.isTypeSupported?.('audio/mp4; codecs="ac-3"')),
    managedMediaSource: Boolean(globalThis.ManagedMediaSource?.isTypeSupported?.('audio/mp4; codecs="ac-3"')),
  });
  globalThis.__harborAc3Patch = { version: 3 };
  console.info("[Harbor Fullscreen Patch] AC3/E-AC3 support enabled for this Activity");
})();
