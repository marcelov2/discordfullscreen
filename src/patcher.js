"use strict";

const electron = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { desktopCapturer, dialog, ipcMain } = electron;
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

// The Harbor picker provides a desktopCapturer source id. Chromium 148 keeps
// the legacy chromeMediaSource path disabled unless the embedding desktop app
// opts into user-media screen capture before the app becomes ready.
try {
  electron.app.commandLine.appendSwitch("enable-usermedia-screen-capturing");
  log("display-capture:legacy-switch-enabled");
} catch (error) {
  log("display-capture:legacy-switch-failed", error);
}

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
const displayMediaSessions = new WeakSet();
const selectedDisplaySources = new WeakMap();
const displayPermissionSessions = new WeakSet();
const processAudioCaptures = new Map();
const processAudioExecutable = path.join(installRoot, "harbor-process-audio.exe");

function stopProcessAudio(token) {
  const capture = processAudioCaptures.get(token);
  if (!capture) return;
  processAudioCaptures.delete(token);
  clearInterval(capture.timer);
  capture.child.kill();
}

async function startProcessAudio(token, sourceId, frame) {
  const windowId = /^window:(\d+):\d+$/.exec(sourceId)?.[1];
  if (!windowId) throw new Error("A fonte selecionada não é uma janela do Windows.");
  if (!fs.existsSync(processAudioExecutable)) {
    throw new Error("O capturador de áudio por aplicativo não está instalado.");
  }
  const child = spawn(processAudioExecutable, [windowId], {
    cwd: installRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = { child, frame, pending: Buffer.alloc(0), sending: false, timer: null };
  processAudioCaptures.set(token, capture);
  try {
    await new Promise((resolve, reject) => {
      let status = "";
      const timeout = setTimeout(() => reject(new Error("O áudio do aplicativo não iniciou em 10 segundos.")), 10000);
      const done = (error) => {
        clearTimeout(timeout);
        child.stderr.off("data", onStatus);
        child.off("error", onError);
        child.off("exit", onExit);
        if (error) reject(error); else resolve();
      };
      const onStatus = (chunk) => {
        status += chunk.toString("utf8");
        if (!status.includes("\n")) return;
        const line = status.slice(0, status.indexOf("\n")).trim();
        done(line.startsWith("READY ") ? null : new Error(`Falha ao capturar áudio: ${line}`));
      };
      const onError = (error) => done(error);
      const onExit = (code) => done(new Error(`Capturador encerrado antes de iniciar (${code}).`));
      child.stderr.on("data", onStatus);
      child.once("error", onError);
      child.once("exit", onExit);
    });
    child.stdout.on("data", (chunk) => {
      capture.pending = Buffer.concat([capture.pending, chunk]);
      // Keep at most 250 ms of complete stereo PCM frames.
      const excess = Math.floor((capture.pending.length - 48000) / 4) * 4;
      if (excess > 0) capture.pending = capture.pending.subarray(excess);
    });
    child.on("exit", (code) => {
      if (processAudioCaptures.get(token) === capture) {
        log(`process-audio:unexpected-exit token=${token} code=${code}`);
        stopProcessAudio(token);
        void frame.executeJavaScript(
          `globalThis.__harborMainCaptureBridge?.stop(${JSON.stringify(token)})`,
        ).catch(() => {});
      }
    });
    capture.timer = setInterval(() => {
      if (capture.sending || capture.pending.length < 4 || processAudioCaptures.get(token) !== capture) return;
      const completeBytes = capture.pending.length - capture.pending.length % 4;
      const payload = capture.pending.subarray(0, completeBytes).toString("base64");
      capture.pending = capture.pending.subarray(completeBytes);
      capture.sending = true;
      void frame.executeJavaScript(
        `globalThis.__harborMainCaptureBridge?.pushAudio(${JSON.stringify(token)}, ${JSON.stringify(payload)})`,
      ).catch((error) => log("process-audio:renderer-delivery-failed", error)).finally(() => {
        capture.sending = false;
      });
    }, 50);
    log(`process-audio:ready source=${sourceId}`);
  } catch (error) {
    stopProcessAudio(token);
    throw error;
  }
}

// Display capture is denied before Electron's permission handler when called
// from the Activity iframe. Capture in Discord's top-level page instead, then
// deliver the selected tracks to that iframe over a local WebRTC connection.
// No signaling server or media upload is involved in this bridge.
const mainCaptureBridge = String.raw`
(() => {
  if (globalThis.__harborMainCaptureBridge) return true;
  const captures = new Map();
  const waitForIce = (peer) => new Promise((resolve) => {
    if (peer.iceGatheringState === "complete") return resolve();
    const timer = setTimeout(done, 5000);
    function done() {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", changed);
      resolve();
    }
    function changed() { if (peer.iceGatheringState === "complete") done(); }
    peer.addEventListener("icegatheringstatechange", changed);
  });
  const stop = (token) => {
    const capture = captures.get(token);
    if (!capture) return false;
    captures.delete(token);
    capture.stream.getTracks().forEach((track) => track.stop());
    capture.peer.close();
    capture.audio?.node.disconnect();
    if (capture.audio?.context) void capture.audio.context.close().catch(() => {});
    return true;
  };
  const makeProcessAudio = () => {
    const context = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    const destination = context.createMediaStreamDestination();
    const node = context.createScriptProcessor(2048, 0, 2);
    const muted = context.createGain();
    muted.gain.value = 0;
    const queue = [];
    let frameOffset = 0;
    let queuedFrames = 0;
    node.onaudioprocess = (event) => {
      const left = event.outputBuffer.getChannelData(0);
      const right = event.outputBuffer.getChannelData(1);
      for (let i = 0; i < left.length; i++) {
        const head = queue[0];
        if (!head) break;
        left[i] = head[frameOffset * 2] / 32768;
        right[i] = head[frameOffset * 2 + 1] / 32768;
        frameOffset++;
        queuedFrames--;
        if (frameOffset * 2 >= head.length) { queue.shift(); frameOffset = 0; }
      }
    };
    node.connect(destination);
    node.connect(muted);
    muted.connect(context.destination);
    return {
      context, node, stream: destination.stream,
      push(base64) {
        const raw = atob(base64);
        const samples = new Int16Array(raw.length / 2);
        for (let i = 0; i < samples.length; i++) {
          samples[i] = (raw.charCodeAt(i * 2) | (raw.charCodeAt(i * 2 + 1) << 8)) << 16 >> 16;
        }
        queue.push(samples);
        queuedFrames += samples.length / 2;
        while (queuedFrames > 12000 && queue.length > 1) {
          queuedFrames -= queue.shift().length / 2;
          frameOffset = 0;
        }
      },
    };
  };
  globalThis.__harborMainCaptureBridge = {
    async offer(token, options, processAudio) {
      if (captures.has(token)) throw new Error("Captura já iniciada.");
      const stream = await navigator.mediaDevices.getDisplayMedia(options);
      if (!stream.getVideoTracks().length) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("A fonte selecionada não produziu vídeo.");
      }
      try {
        const audio = processAudio ? makeProcessAudio() : null;
        const outgoing = audio
          ? new MediaStream([...stream.getVideoTracks(), ...audio.stream.getAudioTracks()])
          : stream;
        const peer = new RTCPeerConnection({ iceServers: [] });
        captures.set(token, { stream, peer, audio });
        if (audio) {
          await audio.context.resume();
          if (audio.context.state !== "running") throw new Error("O áudio da janela não pôde iniciar.");
        }
        outgoing.getTracks().forEach((track) => peer.addTrack(track, outgoing));
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await waitForIce(peer);
        return peer.localDescription.toJSON();
      } catch (error) {
        if (!stop(token)) stream.getTracks().forEach((track) => track.stop());
        throw error;
      }
    },
    pushAudio(token, base64) {
      const audio = captures.get(token)?.audio;
      if (!audio) return false;
      audio.push(base64);
      return true;
    },
    async answer(token, description) {
      const capture = captures.get(token);
      if (!capture) throw new Error("Captura encerrada antes da resposta.");
      await capture.peer.setRemoteDescription(description);
      capture.stream.getVideoTracks()[0]?.addEventListener("ended", () => stop(token), { once: true });
      return true;
    },
    stop,
  };
  window.addEventListener("pagehide", () => [...captures.keys()].forEach(stop));
  return true;
})()
`;

function originHostname(value) {
  try {
    return new URL(String(value || "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isHarborActivityOrigin(origin) {
  return originHostname(origin) === "1519931991066279956.discordsays.com";
}

function isDiscordOrigin(origin) {
  const host = originHostname(origin);
  return host === "discord.com" || host.endsWith(".discord.com") ||
    host === "discordapp.com" || host.endsWith(".discordapp.com");
}

function enableActivityCapturePermissions(session) {
  if (!session || displayPermissionSessions.has(session)) return;

  const capturePermission = (permission) =>
    ["media", "display-capture", "displayCapture"].includes(permission);
  const candidateOrigins = (webContents, requestingOrigin, details) => [
    requestingOrigin,
    details?.requestingUrl,
    details?.securityOrigin,
    details?.requestingOrigin,
    details?.origin,
    details?.embeddingOrigin,
    webContents?.getURL?.(),
  ].filter(Boolean);
  const permitted = (webContents, permission, requestingOrigin, details) => {
    const origins = candidateOrigins(webContents, requestingOrigin, details);
    // Do not grant capture based solely on the Discord embedding origin.
    // A Harbor frame must be identifiable as the actual requesting origin.
    const requester = requestingOrigin || details?.requestingUrl ||
      details?.securityOrigin || details?.requestingOrigin || details?.origin || "";
    const allowed = isDiscordOrigin(requester) ||
      (isHarborActivityOrigin(requester) && capturePermission(permission));
    log(`permission:decision permission=${permission} requester=${originHostname(requester)} candidates=${origins.map(originHostname).join(",")} allowed=${allowed}`);
    return allowed;
  };

  session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) =>
    permitted(webContents, permission, requestingOrigin, details));
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(permitted(webContents, permission, "", details));
  });
  displayPermissionSessions.add(session);
  log("display-capture:permissions-enabled-v2");
}

function isAllowedDisplayOrigin(origin) {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === "discordsays.com" || host.endsWith(".discordsays.com") ||
      host === "discord.com" || host.endsWith(".discord.com") ||
      host === "discordapp.com" || host.endsWith(".discordapp.com");
  } catch {
    return false;
  }
}

function enableActivityDisplayCapture(session) {
  if (!session || displayMediaSessions.has(session)) return true;
  enableActivityCapturePermissions(session);
  if (typeof session.setDisplayMediaRequestHandler !== "function") return false;
  session.setDisplayMediaRequestHandler(async (request, callback) => {
    log(`display-capture:request origin=${request.securityOrigin} audio=${Boolean(request.audioRequested)} frame=${request.frame?.url || "unknown"}`);
    log(`display-capture:request-details ${JSON.stringify({
      securityOrigin: request.securityOrigin,
      videoRequested: request.videoRequested,
      audioRequested: request.audioRequested,
    })}`);
    if (!isAllowedDisplayOrigin(request.securityOrigin)) {
      callback({});
      return;
    }
    try {
      // The Activity starts getDisplayMedia in the same user gesture and sends
      // the selected source through IPC in parallel. Give that IPC message a
      // short window to arrive without losing Chromium's transient activation.
      for (let attempt = 0; attempt < 40 && !selectedDisplaySources.has(session); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: true,
      });
      const selectedSourceId = selectedDisplaySources.get(session);
      selectedDisplaySources.delete(session);
      const selectedSource = selectedSourceId
        ? sources.find((source) => source.id === selectedSourceId)
        : null;
      if (selectedSource) {
        log(`display-capture:selected ${selectedSource.id} ${selectedSource.name}`);
        callback({
          video: selectedSource,
          audio: selectedSource.id.startsWith("screen:") && request.audioRequested ? "loopback" : undefined,
        });
        return;
      }
      const choices = sources.slice(0, 18);
      if (choices.length === 0) {
        callback({});
        return;
      }
      const result = await dialog.showMessageBox({
        type: "question",
        title: "Compartilhar tela no Harbor",
        message: "O que você deseja compartilhar?",
        detail: "Escolha uma tela ou janela. O conteúdo será enviado diretamente aos participantes da sala.",
        buttons: [...choices.map((source) => source.name || "Tela"), "Cancelar"],
        cancelId: choices.length,
        noLink: true,
      });
      const source = choices[result.response];
      callback(source ? {
        video: source,
        audio: source.id.startsWith("screen:") && request.audioRequested ? "loopback" : undefined,
      } : {});
    } catch (error) {
      log("display-capture:request-failed", error);
      callback({});
    }
  }, { useSystemPicker: false });
  displayMediaSessions.add(session);
  log("display-capture:handler-enabled");
  return true;
}

const activityCaptureShim = String.raw`
(() => {
  if (globalThis.__harborDesktopCaptureShimInstalled) return true;
  const mediaDevices = navigator.mediaDevices;
  if (!mediaDevices?.getUserMedia || !mediaDevices?.getDisplayMedia) return false;

  const originalGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);
  const originalGetDisplayMedia = mediaDevices.getDisplayMedia.bind(mediaDevices);
  const REQUEST = "TRANSPORTE_SCREEN_CAPTURE_REQUEST";
  const RESPONSE = "TRANSPORTE_SCREEN_CAPTURE_RESPONSE";
  const pendingCaptures = new Map();
  const bridgedPeers = new Map();

  function createPeer() {
    const candidates = [
      globalThis.RTCPeerConnection,
      globalThis.webkitRTCPeerConnection,
      globalThis.mozRTCPeerConnection,
    ].filter((candidate, index, all) => typeof candidate === "function" && all.indexOf(candidate) === index);
    for (const Candidate of candidates) {
      try { return new Candidate({ iceServers: [] }); } catch {}
    }
    throw new Error("O Discord não disponibilizou uma conexão WebRTC para a ponte local.");
  }

  const waitForIce = (peer) => new Promise((resolve) => {
    if (peer.iceGatheringState === "complete") return resolve();
    const timer = setTimeout(done, 5000);
    function done() {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", changed);
      resolve();
    }
    function changed() { if (peer.iceGatheringState === "complete") done(); }
    peer.addEventListener("icegatheringstatechange", changed);
  });

  globalThis.__harborAcceptBridgedCapture = async function(token, description) {
    const pending = pendingCaptures.get(token);
    if (!pending) throw new Error("A Activity cancelou a captura.");
    const peer = createPeer();
    bridgedPeers.set(token, peer);
    peer.ontrack = (event) => {
      const current = pendingCaptures.get(token);
      if (!current) return;
      const stream = event.streams[0] || new MediaStream([event.track]);
      if (!stream.getVideoTracks().length) return;
      pendingCaptures.delete(token);
      const videoTrack = stream.getVideoTracks()[0];
      const originalStop = videoTrack.stop.bind(videoTrack);
      videoTrack.stop = () => {
        void requestBridge("stop", { token }).catch(() => {});
        peer.close();
        bridgedPeers.delete(token);
        originalStop();
      };
      current.resolve(stream);
      videoTrack.addEventListener("ended", () => {
        void requestBridge("stop", { token }).catch(() => {});
        peer.close();
        bridgedPeers.delete(token);
      }, { once: true });
    };
    try {
      await peer.setRemoteDescription(description);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      await waitForIce(peer);
      return peer.localDescription.toJSON();
    } catch (error) {
      peer.close();
      bridgedPeers.delete(token);
      pendingCaptures.delete(token);
      pending.reject(error);
      throw error;
    }
  };
  window.addEventListener("pagehide", () => {
    for (const peer of bridgedPeers.values()) peer.close();
    bridgedPeers.clear();
  });

  globalThis.__harborStartDisplayCapture = function harborStartDisplayCapture(token, options) {
    const pending = pendingCaptures.get(token);
    if (!pending) return false;
    originalGetDisplayMedia(options).then(
      (stream) => {
        pendingCaptures.delete(token);
        pending.resolve(stream);
      },
      (error) => {
        pendingCaptures.delete(token);
        pending.reject(error);
      },
    );
    return true;
  };

  function requestBridge(action, payload) {
    const requestId = "capture-shim:" + Date.now() + ":" + Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        window.removeEventListener("message", onMessage);
        reject(new Error("A extensão não respondeu à seleção da tela."));
      }, action === "capture" ? 30000 : 8000);
      function onMessage(event) {
        const message = event.data;
        if (event.source !== parent || message?.type !== RESPONSE || message.requestId !== requestId) return;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        if (message.ok) resolve(message.result);
        else reject(new Error(message.error || "A seleção da tela falhou."));
      }
      window.addEventListener("message", onMessage);
      parent.postMessage({ type: REQUEST, requestId, action, payload }, "*");
    });
  }

  function reportCapture(event, details) {
    void requestBridge("diagnostic", { event, details }).catch(() => {});
  }

  mediaDevices.getUserMedia = function harborGetUserMedia(constraints) {
    const mandatory = constraints?.video?.mandatory;
    const sourceId = mandatory?.chromeMediaSourceId;
    if (mandatory?.chromeMediaSource !== "desktop" || typeof sourceId !== "string" || !sourceId) {
      return originalGetUserMedia(constraints);
    }

    const positive = (value) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : undefined;
    const width = positive(mandatory.maxWidth);
    const height = positive(mandatory.maxHeight);
    const frameRate = positive(mandatory.maxFrameRate);
    const video = {};
    if (width) video.width = { ideal: width };
    if (height) video.height = { ideal: height };
    if (frameRate) video.frameRate = { ideal: frameRate, max: frameRate };
    const options = { video, audio: Boolean(constraints?.audio) };
    // A window must never fall back to Electron's system-wide loopback.
    // The privileged bridge attaches Windows process-loopback audio instead.
    const windowSource = sourceId.startsWith("window:");
    if (windowSource) {
      const token = "capture:" + Date.now() + ":" + Math.random().toString(36).slice(2);
      const streamPromise = new Promise((resolve, reject) => {
        pendingCaptures.set(token, { resolve, reject });
      });
      const timeout = setTimeout(() => {
        const pending = pendingCaptures.get(token);
        if (!pending) return;
        pendingCaptures.delete(token);
        pending.reject(new Error("A janela selecionada não iniciou a captura de áudio e vídeo."));
      }, 30000);
      void requestBridge("capture", { sourceId, token, options }).catch((error) => {
        const pending = pendingCaptures.get(token);
        if (!pending) return;
        pendingCaptures.delete(token);
        pending.reject(error);
      });
      return streamPromise.finally(() => clearTimeout(timeout));
    }

    // Start modern display capture synchronously in the picker click. The
    // selection message travels in parallel; the main-process handler already
    // waits briefly for it before granting the requested DesktopCapturerSource.
    try {
      globalThis.__HARBOR_SCREEN_SHARE_LOGS__?.push?.({
        at: new Date().toISOString(),
        event: "capture:modern-direct-attempt",
        details: { sourceId, active: navigator.userActivation?.isActive },
      });
    } catch {}

    reportCapture("modern-direct-attempt", {
      sourceId,
      active: navigator.userActivation?.isActive,
      focus: document.hasFocus(),
    });
    void requestBridge("select", { sourceId }).catch(() => {});
    return originalGetDisplayMedia(options).then((stream) => {
      reportCapture("modern-direct-resolved", { tracks: stream.getVideoTracks().length });
      return stream;
    }, (modernError) => {
      const details = {
        name: modernError?.name || "Error",
        message: modernError?.message || String(modernError),
        sourceId,
        origin: location.origin,
        active: navigator.userActivation?.isActive,
        focus: document.hasFocus(),
        secureContext: isSecureContext,
      };
      try {
        globalThis.__HARBOR_SCREEN_SHARE_LOGS__?.push?.({
          at: new Date().toISOString(),
          event: "capture:modern-direct-failed",
          details,
        });
        console.error("[harbor-capture] direct getDisplayMedia failed", details);
      } catch {}
      reportCapture("modern-direct-failed", details);
      // In current Chromium the legacy desktop getUserMedia request can stay
      // pending indefinitely. The privileged Discord-frame bridge works for
      // the same source and must be started without waiting for that request.
      const token = "capture:" + Date.now() + ":" + Math.random().toString(36).slice(2);
      const streamPromise = new Promise((resolve, reject) => {
        pendingCaptures.set(token, { resolve, reject });
      });
      const timeout = setTimeout(() => {
        const pending = pendingCaptures.get(token);
        if (!pending) return;
        pendingCaptures.delete(token);
        pending.reject(new Error("A transmissão local não recebeu vídeo da janela principal."));
      }, 15000);
      reportCapture("privileged-bridge-attempt", { sourceId });
      void requestBridge("capture", { sourceId, token, options }).catch((bridgeError) => {
        const pending = pendingCaptures.get(token);
        if (!pending) return;
        pendingCaptures.delete(token);
        reportCapture("privileged-bridge-failed", {
          name: bridgeError?.name || "Error",
          message: bridgeError?.message || String(bridgeError),
        });
        pending.reject(bridgeError);
      });
      return streamPromise.then((stream) => {
        reportCapture("privileged-bridge-resolved", { tracks: stream.getVideoTracks().length });
        return stream;
      }).finally(() => clearTimeout(timeout));
    });
  };
  globalThis.__harborDesktopCaptureShimInstalled = true;
  globalThis.__harborDesktopCaptureShimVersion = "direct-modern-v2";
  return true;
})()
`;

function installActivityCaptureShim(webContents) {
  const inject = (frame) => {
    try {
      if (!frame || !isHarborActivityOrigin(frame.url)) return;
      void frame.executeJavaScript(activityCaptureShim, true).then(
        (installed) => {
          log(`display-capture:activity-shim installed=${Boolean(installed)}`);
          void frame.executeJavaScript(
            `JSON.stringify({ origin: location.origin, allowed: document.permissionsPolicy?.allowsFeature?.("display-capture") ?? document.featurePolicy?.allowsFeature?.("display-capture") ?? null })`,
          ).then(
            (policy) => log(`display-capture:activity-policy ${policy}`),
            (error) => log("display-capture:activity-policy-failed", error),
          );
        },
        (error) => log("display-capture:activity-shim-failed", error),
      );
    } catch (error) {
      log("display-capture:activity-shim-failed", error);
    }
  };

  const findFrame = (processId, routingId) => {
    try {
      return electron.webFrameMain?.fromId?.(processId, routingId) || null;
    } catch {
      return null;
    }
  };

  webContents.on("did-frame-finish-load", (_event, isMainFrame, processId, routingId) => {
    if (!isMainFrame) inject(findFrame(processId, routingId));
  });
  webContents.on("did-frame-navigate", (_event, _url, _code, _status, isMainFrame, processId, routingId) => {
    if (!isMainFrame) inject(findFrame(processId, routingId));
  });
}

ipcMain.removeHandler("harbor-screen-capture:prepare");
ipcMain.handle("harbor-screen-capture:prepare", (event) => {
  try {
    return enableActivityDisplayCapture(event.sender.session);
  } catch (error) {
    log("display-capture:setup-failed", error);
    return false;
  }
});

ipcMain.removeHandler("harbor-screen-capture:request");
ipcMain.handle("harbor-screen-capture:request", async (event, request) => {
  if (!enableActivityDisplayCapture(event.sender.session)) {
    throw new Error("A captura de tela não está disponível nesta versão do Discord.");
  }
  const action = typeof request?.action === "string" ? request.action : "";
  log(`display-capture:ipc action=${action}`);
  if (action === "diagnostic") {
    log(`display-capture:activity-diagnostic ${JSON.stringify(request?.payload || {})}`);
    return true;
  }
  if (action === "list") {
    const sources = await desktopCapturer.getSources({
      types: ["window", "screen"],
      thumbnailSize: { width: 640, height: 360 },
      fetchWindowIcons: true,
    });
    log(`display-capture:sources count=${sources.length}`);
    return sources.map((source) => ({
      id: source.id,
      name: source.name || "Tela",
      kind: source.id.startsWith("screen:") ? "screen" : "window",
      thumbnail: source.thumbnail?.isEmpty() ? "" : source.thumbnail.toDataURL(),
      appIcon: source.appIcon?.isEmpty() ? "" : source.appIcon?.toDataURL() || "",
    }));
  }
  if (action === "select") {
    const sourceId = typeof request?.payload?.sourceId === "string"
      ? request.payload.sourceId
      : "";
    if (!sourceId) throw new Error("Nenhuma tela foi selecionada.");
    const sources = await desktopCapturer.getSources({
      types: ["window", "screen"],
      thumbnailSize: { width: 0, height: 0 },
    });
    if (!sources.some((source) => source.id === sourceId)) {
      throw new Error("A janela selecionada não está mais disponível.");
    }
    selectedDisplaySources.set(event.sender.session, sourceId);
    log(`display-capture:queued ${sourceId}`);
    return true;
  }
  if (action === "stop") {
    const token = typeof request?.payload?.token === "string" ? request.payload.token : "";
    if (!token || !isDiscordOrigin(event.sender.getURL())) return false;
    stopProcessAudio(token);
    return event.sender.mainFrame.executeJavaScript(
      `Boolean(globalThis.__harborMainCaptureBridge?.stop(${JSON.stringify(token)}))`,
    );
  }
  if (action === "capture") {
    const sourceId = typeof request?.payload?.sourceId === "string"
      ? request.payload.sourceId
      : "";
    const token = typeof request?.payload?.token === "string"
      ? request.payload.token
      : "";
    const options = request?.payload?.options && typeof request.payload.options === "object"
      ? request.payload.options
      : { video: true, audio: false };
    if (!sourceId || !token) throw new Error("Pedido de captura incompleto.");
    if (!isDiscordOrigin(event.sender.getURL())) {
      throw new Error("A captura precisa partir da janela do Discord.");
    }

    const activityFrame = event.sender.mainFrame?.framesInSubtree?.find?.(
      (frame) => isHarborActivityOrigin(frame.url),
    );
    if (!activityFrame) throw new Error("A janela do Harbor não foi encontrada.");

    const sources = await desktopCapturer.getSources({
      types: ["window", "screen"],
      thumbnailSize: { width: 0, height: 0 },
    });
    const selectedSource = sources.find((source) => source.id === sourceId);
    if (!selectedSource) {
      throw new Error("A janela selecionada não está mais disponível.");
    }

    selectedDisplaySources.set(event.sender.session, sourceId);
    const mainFrame = event.sender.mainFrame;
    const processAudio = selectedSource.id.startsWith("window:");
    try {
      await mainFrame.executeJavaScript(mainCaptureBridge, true);
      if (processAudio) await startProcessAudio(token, sourceId, mainFrame);
      const captureOptions = {
        video: options.video || true,
        audio: !processAudio,
      };
      const offer = await mainFrame.executeJavaScript(
        `globalThis.__harborMainCaptureBridge.offer(${JSON.stringify(token)}, ${JSON.stringify(captureOptions)}, ${processAudio})`,
        true,
      );
      const answer = await activityFrame.executeJavaScript(
        `globalThis.__harborAcceptBridgedCapture(${JSON.stringify(token)}, ${JSON.stringify(offer)})`,
        true,
      );
      await mainFrame.executeJavaScript(
        `globalThis.__harborMainCaptureBridge.answer(${JSON.stringify(token)}, ${JSON.stringify(answer)})`,
        true,
      );
      log(`display-capture:bridged ${sourceId}`);
      return true;
    } catch (error) {
      stopProcessAudio(token);
      selectedDisplaySources.delete(event.sender.session);
      void mainFrame.executeJavaScript(
        `globalThis.__harborMainCaptureBridge?.stop(${JSON.stringify(token)})`,
      ).catch(() => {});
      log("display-capture:bridge-failed", error);
      throw error;
    }
  }
  throw new Error("Ação de captura desconhecida.");
});

ipcMain.removeHandler("harbor-cast:request");
ipcMain.handle("harbor-cast:request", async (_event, request) => {
  const action = typeof request?.action === "string" ? request.action : "";
  return chromecastBridge.command(action, request?.payload);
});

// Keep the custom runtime grouped and identified as Discord in the taskbar,
// notifications, volume mixer and other Windows shell surfaces.
try {
  electron.app.setName("Discord");
  if (process.platform === "win32") {
    electron.app.setAppUserModelId("com.squirrel.Discord.Discord");
  }
} catch (error) {
  log("discord-identity:failed", error);
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
    // Register display capture before the Activity iframe is created. Waiting
    // for the renderer's prepare event is too late for Chromium's permissions
    // policy and causes getDisplayMedia() to fail with NotAllowedError.
    enableActivityDisplayCapture(this.webContents.session);
    installActivityCaptureShim(this.webContents);
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

