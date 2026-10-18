import { spawn } from "node:child_process";
import path from "node:path";

const dir = path.join(import.meta.dirname, "out", "Release");
const toneExe = path.join(dir, "harbor-audio-test-tone.exe");
const captureExe = path.join(dir, "harbor-process-audio.exe");
const processes = [];
const cleanup = () => processes.forEach((process) => process.kill());
process.once("exit", cleanup);

async function launchTone(frequency) {
  const child = spawn(toneExe, [String(frequency)], { windowsHide: true });
  processes.push(child);
  return await new Promise((resolve, reject) => {
    let line = "";
    child.stdout.on("data", (chunk) => {
      line += chunk.toString();
      if (line.includes("\n")) resolve(line.trim());
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Tone ${frequency} exited ${code}`)));
  });
}

const ownWindow = await launchTone(440);
await launchTone(880);
const capture = spawn(captureExe, [ownWindow], { windowsHide: true });
processes.push(capture);
const chunks = [];
capture.stdout.on("data", (chunk) => chunks.push(chunk));
const status = await new Promise((resolve, reject) => {
  let line = "";
  capture.stderr.on("data", (chunk) => {
    line += chunk.toString();
    if (line.includes("\n")) resolve(line.trim());
  });
  capture.once("error", reject);
  setTimeout(() => reject(new Error("Capture helper did not start")), 10000);
});
if (!status.startsWith("READY ")) throw new Error(status);
await new Promise((resolve) => setTimeout(resolve, 2500));
cleanup();
const pcm = Buffer.concat(chunks);
if (pcm.length < 48000) throw new Error(`Too little audio: ${pcm.length} bytes`);
function magnitude(frequency) {
  const frames = Math.min(Math.floor(pcm.length / 4), 48000);
  let real = 0;
  let imag = 0;
  for (let n = 0; n < frames; n++) {
    const sample = pcm.readInt16LE(n * 4);
    const angle = 2 * Math.PI * frequency * n / 48000;
    real += sample * Math.cos(angle);
    imag += sample * Math.sin(angle);
  }
  return Math.hypot(real, imag) / frames;
}
const target = magnitude(440);
const other = magnitude(880);
const result = { status, bytes: pcm.length, target440: target, excluded880: other, isolationDb: 20 * Math.log10(target / Math.max(other, 0.0001)) };
console.log(JSON.stringify(result, null, 2));
if (target < 10 || result.isolationDb < 20) process.exitCode = 1;
