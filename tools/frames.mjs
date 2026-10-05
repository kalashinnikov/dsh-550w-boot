/**
 * Renders the boot sheet to a frame sequence through the Chrome DevTools
 * Protocol, so the whole 11.6s run costs one browser launch instead of 290.
 *
 * The preview shell pauses every animation and drives it with --w550-t (a
 * negative animation-delay), so setting that variable steps the picture to an
 * exact moment: every frame here is the same deterministic state the frozen-
 * frame screenshots have been verifying all along.
 *
 *   node tools/frames.mjs          # expects Edge already listening on 9222
 *
 * Start the browser first, pointed at the frozen-frame shell in this folder:
 *   msedge --headless=new --remote-debugging-port=9222 --window-size=1280,820 \
 *          --user-data-dir=%TEMP%\edge550w file:///<repo>/tools/preview.html?t=0
 */
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PORT = Number(process.argv[2] || 9222);
const OUT = fileURLToPath(new URL("./frames", import.meta.url));
const FPS = 25;
const DUR = 11.6;

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && /preview\.html/.test(t.url))
  || list.find((t) => t.type === "page");
if (!page) throw new Error("no page target on port " + PORT);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.rej(new Error(JSON.stringify(m.error)));
    else p.res(m.result);
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = (expression, awaitPromise = false) =>
  send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });

await send("Page.enable");
await send("Runtime.enable");
// the sheet leans on monospace + Microsoft YaHei; never shoot before they land
await evaluate("document.fonts.ready", true);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const total = Math.round(FPS * DUR);
const started = Date.now();
for (let i = 0; i < total; i++) {
  const t = i / FPS;
  await evaluate(`document.documentElement.style.setProperty("--w550-t","-${t.toFixed(4)}s")`);
  // two frames of layout, so what we grab is painted, not pending
  await evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(1))))", true);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT}/f${String(i).padStart(4, "0")}.png`, Buffer.from(shot.data, "base64"));
  if (i % 25 === 0) console.log(`frame ${i}/${total}  t=${t.toFixed(2)}s`);
}
console.log(`done: ${total} frames in ${((Date.now() - started) / 1000).toFixed(1)}s -> ${OUT}`);
ws.close();
