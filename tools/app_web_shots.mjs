// Screenshots of the Expo app's web build (demo sensor) in headless Chrome at phone size.
// Usage: (cd app && npx expo export --platform web) && python3 -m http.server 8766 -d app/dist &
//        node tools/app_web_shots.mjs [outdir]
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = process.argv[2] || tmpdir();
const base = "http://localhost:8766";
const profile = mkdtempSync(join(tmpdir(), "myoblue-app-"));
const proc = spawn(process.env.CHROME || "google-chrome-stable", ["--headless=new", "--remote-debugging-port=9334",
  `--user-data-dir=${profile}`, "--window-size=412,915", "--force-device-scale-factor=2", "--no-first-run", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0;
const pending = new Map(), errors = [];
const send = (method, params = {}) => new Promise((resolve) => { const m = { id: ++id, method, params }; pending.set(m.id, resolve); ws.send(JSON.stringify(m)); });
const js = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.value;
const click = (text) => js(`(() => { const el = [...document.querySelectorAll('[role=button],[role=tab],a,div')].reverse().find(e => e.textContent.trim() === ${JSON.stringify(text)}); if (el) { el.click(); return true } return false })()`);
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(out, name), Buffer.from(r.data, "base64")); console.log("saved", name); };
try {
  let target;
  for (let i = 0; i < 50 && !target; i++) { await sleep(200); try { target = (await (await fetch("http://127.0.0.1:9334/json")).json()).find((t) => t.type === "page"); } catch {} }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || {}); pending.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description?.split("\n")[0]);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 200)); };
  await send("Runtime.enable"); await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
  await send("Page.navigate", { url: base + "/" });
  await sleep(3000);
  await shot("app-empty.png");
  console.log("demo button:", await click("Try a demo sensor"));
  await sleep(5000);
  await shot("app-live.png");
  console.log("settings tab:", await click("Settings"));
  await sleep(1200);
  await shot("app-settings.png");
  console.log("recordings tab:", await click("Recordings"));
  await sleep(1200);
  await shot("app-recordings.png");
  console.log("errors:", errors.length ? errors : "none");
} finally { ws?.close(); proc.kill(); await sleep(300); rmSync(profile, { recursive: true, force: true }); }
