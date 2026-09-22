// End-to-end check of the web app with the demo sensor, in headless Chrome.
// Usage: python3 -m http.server 8765 -d web &  node tools/web_selftest.mjs [url]
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.argv[2] || "http://localhost:8765/?demo";
const chrome = process.env.CHROME || "google-chrome-stable";
const profile = mkdtempSync(join(tmpdir(), "myoblue-test-"));
const proc = spawn(chrome, ["--headless=new", "--remote-debugging-port=9333", `--user-data-dir=${profile}`,
  "--window-size=412,900", "--no-first-run", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws, id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const msg = { id: ++id, method, params };
  pending.set(msg.id, { resolve, reject });
  ws.send(JSON.stringify(msg));
});
const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

const errors = [];
try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch("http://127.0.0.1:9333/json")).json()).find((t) => t.type === "page"); } catch {}
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result || {}); pending.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a) => a.value).join(" "));
  };
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url });
  await sleep(3000);

  const step = async (name, expr) => {
    const v = await evaluate(`(async () => { const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const until = async (fn, ms = 30000) => { const t = Date.now(); while (!fn() && Date.now() - t < ms) await wait(100); return fn(); };
      ${expr} })()`);
    console.log(`\n## ${name}\n` + JSON.stringify(v, null, 2));
    return v;
  };

  await step("live demo", `const s = [...sensors.values()][0]; await wait(1500);
    return { state: s.state, rate: Math.round(s.rate), battery: s.battery?.toFixed(2), lost: s.lossPct.toFixed(2) };`);

  await step("calibration", `
    document.querySelector('[data-action="calibrate"]').click();
    [...document.querySelectorAll('#calButtons button')].find(b => b.textContent === 'Start').click();
    await until(() => document.querySelector('#calTitle').textContent === 'Calibration results');
    const table = document.querySelector('.cal-table').innerText;
    [...document.querySelectorAll('#calButtons button')].find(b => b.textContent === 'Save calibration').click();
    const s = [...sensors.values()][0];
    return { table, saved: !!s.cal, stored: !!localStorage.getItem('myoblue.cal.' + s.name), card: s.ui.calV.textContent };`);

  await step("recording with markers", `
    document.querySelector('[data-action="record"]').click();
    document.querySelector('#recName').value = 'Test biceps';
    document.querySelector('#recDialog button[value="start"]').click();
    await until(() => recorder.active);
    await wait(2500);
    document.querySelectorAll('#markerChips .chip')[2].click();
    await wait(2500);
    document.querySelectorAll('#markerChips .chip')[0].click();
    await wait(2000);
    const badge = document.querySelector('#recTime').textContent;
    document.querySelector('[data-action="stop"]').click();
    await until(() => !recorder.active);
    await wait(300);
    return { badge, list: document.querySelector('#recList').innerText.split('\\n').slice(0, 3) };`);

  await step("export", `
    const rec = (await db.allRecordings()).find(r => r.name === 'Test biceps');
    const { csv, json } = await buildExport(rec);
    const lines = (await csv.text()).trim().split('\\n');
    const meta = JSON.parse(await json.text());
    const t = lines.slice(1).map(l => +l.split(',')[0]);
    let nonMonotonic = 0; for (let i = 1; i < t.length; i++) if (!(t[i] > t[i - 1])) nonMonotonic++;
    const withRaw = lines.slice(1).filter(l => l.split(',')[1] !== '').length;
    return { file: csv.name, header: lines[0], rows: lines.length - 1, rowsWithData: withRaw, first: lines[1], nonMonotonic,
      markers: lines.filter(l => l.endsWith('"')).map(l => l.split(',')[0] + ' ' + l.split(',').pop()),
      metaMarkers: meta.markers.map(m => m.t.toFixed(2) + ' ' + m.label), duration: meta.durationSeconds,
      sensors: meta.sensors.map(x => ({ col: x.column, packets: x.packets, msPerPacket: x.clockMsPerPacket, calibrated: !!x.calibration })) };`);

  await step("envelope view + delete", `
    document.querySelector('#viewMode').value = 'envelope'; document.querySelector('#viewMode').dispatchEvent(new Event('change'));
    await wait(500);
    const del = [...document.querySelectorAll('#recList button')].find(b => b.textContent === 'Delete');
    del.click(); del.click(); await wait(800);
    return { viewMode: settings.viewMode, recordingsLeft: (await db.allRecordings()).length, chunksLeft: (await db.chunks((await db.allRecordings())[0]?.id ?? 'none')).length };`);

  await step("two sensors", `
    addDemoSensor(); await wait(1500);
    document.querySelector('[data-action="record"]').click();
    document.querySelector('#recName').value = 'Two sensors';
    document.querySelector('#recDialog button[value="start"]').click();
    await until(() => recorder.active); await wait(3000);
    document.querySelector('[data-action="stop"]').click(); await until(() => !recorder.active);
    const rec = (await db.allRecordings()).find(r => r.name === 'Two sensors');
    const lines = (await (await buildExport(rec)).csv.text()).trim().split('\\n');
    const both = lines.slice(1).filter(l => { const c = l.split(','); return c[1] !== '' && c[5] !== ''; }).length;
    return { header: lines[0], rows: lines.length - 1, rowsWithBothSensors: both };`);

  const shot = await send("Page.captureScreenshot", { format: "png" });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.env.SHOT || join(tmpdir(), "myoblue-selftest.png"), Buffer.from(shot.data, "base64"));
  console.log("\nerrors:", errors.length ? errors : "none");
} finally {
  ws?.close();
  proc.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
