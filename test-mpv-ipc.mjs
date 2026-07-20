import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

const mpv = [process.env.HARBOR_MPV_PATH, "C:\\mpv\\mpv.exe", "C:\\mvp\\mpv.exe"]
  .filter(Boolean)
  .find((candidate) => fs.existsSync(candidate));
if (!mpv) throw new Error("mpv.exe não encontrado");

const pipe = `\\\\.\\pipe\\harbor-mpv-test-${process.pid}-${Date.now()}`;
const child = spawn(mpv, [
  "--no-config", "--idle=yes", "--vo=null", "--ao=null",
  `--input-ipc-server=${pipe}`,
  "av://lavfi:testsrc=size=320x240:rate=30:duration=30",
], { stdio: "ignore", windowsHide: true, shell: false });

let socket;
for (let attempt = 0; attempt < 50 && !socket; attempt += 1) {
  socket = await new Promise((resolve) => {
    const candidate = net.createConnection(pipe);
    candidate.once("connect", () => resolve(candidate));
    candidate.once("error", () => { candidate.destroy(); resolve(null); });
  });
  if (!socket) await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!socket) throw new Error("pipe IPC do MPV não abriu");

socket.setEncoding("utf8");
let buffer = "";
let nextId = 0;
const pending = new Map();
socket.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const message = JSON.parse(line);
    pending.get(message.request_id)?.(message);
    pending.delete(message.request_id);
  }
});
function command(value) {
  const requestId = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`timeout ${value[0]}`)); }, 2000);
    pending.set(requestId, (message) => { clearTimeout(timer); resolve(message); });
    socket.write(`${JSON.stringify({ command: value, request_id: requestId })}\n`);
  });
}

try {
  const results = [];
  results.push(await command(["get_property", "pause"]));
  results.push(await command(["set_property", "pause", true]));
  results.push(await command(["seek", 5, "absolute"]));
  results.push(await command(["get_property", "time-pos"]));
  results.push(await command(["set_property", "pause", false]));
  for (const result of results) {
    if (result.error !== "success") throw new Error(JSON.stringify(result));
  }
  console.log(`MPV IPC validado: ${path.basename(mpv)}; play/pause/seek responderam com sucesso.`);
} finally {
  try { socket.write(`${JSON.stringify({ command: ["quit"] })}\n`); } catch {}
  socket.destroy();
  setTimeout(() => { if (!child.killed) child.kill(); }, 250).unref();
}
