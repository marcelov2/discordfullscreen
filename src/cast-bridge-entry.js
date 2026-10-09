"use strict";

const multicastDns = require("multicast-dns");
const { Client, DefaultMediaReceiver } = require("castv2-client");

const SERVICE = "_googlecast._tcp.local";
const DEFAULT_PORT = 8009;

function decodeTxt(parts) {
  const result = {};
  for (const part of parts || []) {
    const text = Buffer.isBuffer(part) ? part.toString("utf8") : String(part);
    const index = text.indexOf("=");
    if (index > 0) result[text.slice(0, index)] = text.slice(index + 1);
  }
  return result;
}

function unwrapDiscordMediaUrl(value) {
  try {
    const url = new URL(String(value));
    if (!url.hostname.endsWith("discordsays.com")) return url.href;
    if (url.pathname === "/__media/proxy") {
      return url.searchParams.get("src") || url.href;
    }
    const marker = "/activity-proxy/";
    const index = url.pathname.indexOf(marker);
    if (index >= 0) {
      let raw = decodeURIComponent(url.pathname.slice(index + marker.length));
      if (raw.startsWith("https/")) raw = `https://${raw.slice(6)}`;
      else if (raw.startsWith("http/")) raw = `http://${raw.slice(5)}`;
      return raw + url.search;
    }
    return url.href;
  } catch {
    return String(value || "");
  }
}

function withTimeout(work, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} timed out`));
    }, timeoutMs);
    work((error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    });
  });
}

async function discoverChromecasts(timeoutMs = 2600) {
  const mdns = multicastDns();
  const services = new Map();
  const hosts = new Map();

  const consume = (packet, rinfo) => {
    const records = [
      ...(packet.answers || []),
      ...(packet.additionals || []),
      ...(packet.authorities || []),
    ];
    for (const record of records) {
      if (record.type === "A") hosts.set(String(record.name).toLowerCase(), record.data);
      if (record.type !== "SRV" && record.type !== "TXT") continue;
      const key = String(record.name).toLowerCase();
      if (!key.endsWith(`.${SERVICE}`)) continue;
      const row = services.get(key) || { key, fallbackHost: rinfo?.address || null };
      if (record.type === "SRV") {
        row.target = String(record.data?.target || "").toLowerCase();
        row.port = Number(record.data?.port) || DEFAULT_PORT;
      } else {
        row.txt = { ...(row.txt || {}), ...decodeTxt(record.data) };
      }
      services.set(key, row);
    }
  };

  mdns.on("response", consume);
  mdns.on("error", () => {});
  mdns.query([{ name: SERVICE, type: "PTR" }]);
  const repeat = setInterval(() => mdns.query([{ name: SERVICE, type: "PTR" }]), 700);
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  clearInterval(repeat);
  mdns.destroy();

  return [...services.values()]
    .map((row) => {
      const host = hosts.get(row.target) || row.fallbackHost;
      if (!host) return null;
      const txt = row.txt || {};
      const id = txt.id || row.key;
      return {
        id: `chromecast:${id}`,
        name: txt.fn || row.key.slice(0, -(`.${SERVICE}`.length)),
        host,
        port: row.port || DEFAULT_PORT,
        model: txt.md || "Chromecast",
        kind: "chromecast",
        control_url: null,
        audio_only: txt.ca === "5",
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

class HarborChromecastBridge {
  constructor() {
    this.client = null;
    this.player = null;
    this.status = null;
  }

  async close() {
    const client = this.client;
    this.player = null;
    this.client = null;
    this.status = null;
    try { client?.close(); } catch {}
  }

  async load(options) {
    await this.close();
    const host = String(options?.host || "");
    if (!host) throw new Error("Chromecast sem endereco de rede");
    const client = new Client();
    this.client = client;
    let connected = false;
    client.on("error", (error) => {
      if (connected) this.status = { ...(this.status || {}), playerState: "IDLE", error: error.message };
    });
    await withTimeout((done) => client.connect({ host, port: Number(options.port) || DEFAULT_PORT }, () => done()), 7000, "Chromecast connection");
    connected = true;
    const player = await withTimeout((done) => client.launch(DefaultMediaReceiver, done), 8000, "Chromecast receiver");
    this.player = player;
    player.on("status", (status) => { this.status = status; });

    const sourceUrl = unwrapDiscordMediaUrl(options.url);
    const media = {
      contentId: sourceUrl,
      contentType: options.contentType || "video/mp4",
      streamType: options.isLive ? "LIVE" : "BUFFERED",
      metadata: {
        type: 0,
        metadataType: 0,
        title: options.title || "TRANSPORTE",
        images: options.poster ? [{ url: unwrapDiscordMediaUrl(options.poster) }] : [],
      },
    };
    const loadOptions = {
      autoplay: true,
      currentTime: Math.max(0, Number(options.startTimeSec) || 0),
    };
    const sub = options.subtitle;
    if (sub?.kind === "external" && sub.url && String(sub.format).toLowerCase() === "vtt") {
      media.tracks = [{
        trackId: 1,
        type: "TEXT",
        trackContentId: unwrapDiscordMediaUrl(sub.url),
        trackContentType: "text/vtt",
        subtype: "SUBTITLES",
        name: "Legenda",
      }];
      loadOptions.activeTrackIds = [1];
    }
    const status = await withTimeout((done) => player.load(media, loadOptions, done), 15000, "Chromecast media load");
    this.status = status || this.status;
    return { ok: true, direct: true, url: sourceUrl };
  }

  async command(action, payload) {
    if (action === "discover") return discoverChromecasts();
    if (action === "load") return this.load(payload || {});
    if (action === "ffmpeg-present") return false;
    if (action === "stop") {
      if (this.player) await withTimeout((done) => this.player.stop(done), 4000, "Chromecast stop").catch(() => {});
      await this.close();
      return null;
    }
    if (action === "status") {
      if (!this.player) return null;
      const current = await withTimeout((done) => this.player.getStatus(done), 2500, "Chromecast status").catch(() => this.status);
      if (current) this.status = current;
      return {
        position_sec: Number(this.status?.currentTime) || 0,
        player_state: String(this.status?.playerState || "IDLE"),
        connected: !!this.player,
      };
    }
    if (!this.player) throw new Error("Nenhuma transmissao Chromecast ativa");
    if (action === "play" || action === "pause") {
      await withTimeout((done) => this.player[action](done), 4000, `Chromecast ${action}`);
      return null;
    }
    if (action === "seek") {
      await withTimeout((done) => this.player.seek(Math.max(0, Number(payload?.sec) || 0), done), 4000, "Chromecast seek");
      return null;
    }
    throw new Error(`Acao Chromecast desconhecida: ${action}`);
  }
}

module.exports = { HarborChromecastBridge, unwrapDiscordMediaUrl };
