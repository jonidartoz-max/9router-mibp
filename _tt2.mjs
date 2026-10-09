
import { spawn } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const EXE = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
             "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
             "C:/Program Files/Google/Chrome/Application/chrome.exe"].find(p => fs.existsSync(p));
const PORT = 9511;
const profile = path.join(os.tmpdir(), "ds-tt2");
fs.rmSync(profile, { recursive: true, force: true });
const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--remote-allow-origins=*`,
  `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--start-maximized", "--new-window", "about:blank"], { detached: true, stdio: "ignore" });
child.unref();
const base = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jget = async p => (await fetch(base + p)).json();
for (let i = 0; i < 60; i++) { try { await jget("/json/version"); break; } catch { await sleep(400); } }
const list = await jget("/json/list");
const page = list.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", r));
let seq=0; const pend=new Map(); const posts=[];
ws.addEventListener("message", ev => { const m=JSON.parse(ev.data);
  if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}
  if(m.method==="Network.requestWillBeSent" && /api\/v0/.test(m.params?.request?.url||""))
    posts.push(m.params.request.method+" "+m.params.request.url.replace("https://chat.deepseek.com","")+" || "+(m.params.request.postData||"").slice(0,200));
});
const send=(m,p={})=>new Promise(res=>{const i=++seq;pend.set(i,res);ws.send(JSON.stringify({id:i,method:m,params:p}));});
const ev2 = async e => (await send("Runtime.evaluate",{expression:e,returnByValue:true,awaitPromise:true}))?.result?.result?.value;

await send("Network.enable");
await send("Page.enable");
await send("Page.navigate", { url: "https://chat.deepseek.com/sign_up" });
try { await send("Page.bringToFront"); } catch {}

// wait for the form to actually render
let form = null;
for (let i=0;i<24;i++){
  await sleep(2500);
  form = await ev2(`JSON.stringify({inputs:[...document.querySelectorAll('input')].map(i=>i.placeholder),buttons:[...document.querySelectorAll('button')].map(b=>b.innerText.trim()).filter(Boolean),vis:document.visibilityState})`);
  const f = JSON.parse(form||"{}");
  if ((f.inputs||[]).length >= 3) { console.log(`form ready at t+${(i+1)*2.5}s`); break; }
  console.log(`t+${(i+1)*2.5}s`, form);
}
console.log("\nFINAL FORM:", form);

console.log("\n=== turnstile detail ===");
console.log(await ev2(`(()=>{
  const w=document.getElementById('cf-turnstile');
  const f=document.querySelector('iframe[src*="challenges.cloudflare"]');
  return JSON.stringify({
    tsGlobal: typeof window.turnstile,
    containerSize: w? Math.round(w.getBoundingClientRect().width)+'x'+Math.round(w.getBoundingClientRect().height):'no-el',
    iframe: f? Math.round(f.getBoundingClientRect().width)+'x'+Math.round(f.getBoundingClientRect().height):'none',
    tokenInput: !!document.querySelector('input[name="cf-turnstile-response"]'),
    tokenLen: (document.querySelector('input[name="cf-turnstile-response"]')||{}).value?.length || 0
  });
})()`));

console.log("\n=== api calls ===");
for (const p of posts.slice(0,12)) console.log("  ", p);

try { const bv = await jget("/json/version"); const bws = new WebSocket(bv.webSocketDebuggerUrl);
  await new Promise(r => { const t=setTimeout(r,1500); bws.addEventListener("open",()=>{bws.send(JSON.stringify({id:1,method:"Browser.close",params:{}}));setTimeout(()=>{clearTimeout(t);r();},400);}); bws.addEventListener("error",()=>{clearTimeout(t);r();}); }); } catch {}
setTimeout(()=>process.exit(0),800);
