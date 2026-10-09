
import { spawn } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const EXE = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
             "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
             "C:/Program Files/Google/Chrome/Application/chrome.exe"].find(p => fs.existsSync(p));
const PORT = 9499;
const profile = path.join(os.tmpdir(), "ds-tt");
fs.rmSync(profile, { recursive: true, force: true });
const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--remote-allow-origins=*`,
  `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--window-size=1000,800", "--new-window", "about:blank"], { detached: true, stdio: "ignore" });
child.unref();
const base = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jget = async p => (await fetch(base + p)).json();
for (let i = 0; i < 60; i++) { try { await jget("/json/version"); break; } catch { await sleep(400); } }
const list = await jget("/json/list");
const page = list.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", r));
let seq=0; const pend=new Map();
ws.addEventListener("message", ev => { const m=JSON.parse(ev.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);} });
const send=(m,p={})=>new Promise(res=>{const i=++seq;pend.set(i,res);ws.send(JSON.stringify({id:i,method:m,params:p}));});
const ev2 = async e => (await send("Runtime.evaluate",{expression:e,returnByValue:true,awaitPromise:true}))?.result?.result?.value;

await send("Page.enable");
await send("Page.navigate", { url: "https://chat.deepseek.com/sign_up" });
await sleep(9000);

// Watch the Turnstile widget for 45s without touching it
for (let i = 1; i <= 9; i++) {
  const st = await ev2(`(()=>{
    const inp=document.querySelector('input[name="cf-turnstile-response"]');
    const tok=inp?inp.value:'';
    const f=document.querySelector('iframe[src*="challenges.cloudflare"]');
    const w=document.getElementById('cf-turnstile');
    return JSON.stringify({
      tokenLen: tok?tok.length:0,
      iframe: f? Math.round(f.getBoundingClientRect().width)+'x'+Math.round(f.getBoundingClientRect().height):'none',
      container: w? (w.getBoundingClientRect().width+'x'+w.getBoundingClientRect().height):'none',
      containerHTML: w? w.innerHTML.slice(0,80):'',
      tsGlobal: typeof window.turnstile
    });
  })()`);
  console.log(`t+${i*5}s`, st);
  if (st && JSON.parse(st).tokenLen > 0) { console.log(">>> AUTO-SOLVED <<<"); break; }
  await sleep(5000);
}

// Also: try clicking the send-code button after filling email, see if turnstile blocks
const EMAIL = "9r" + Date.now().toString().slice(-9) + "@mailinator.com";
await ev2(`(()=>{const i=document.querySelector('input[placeholder="Email address"]');if(!i)return 0;const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(i,${JSON.stringify(EMAIL)});i.dispatchEvent(new Event('input',{bubbles:true}));return 1;})()`);
await sleep(1500);
console.log("\nsendcode btn:", await ev2(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/send code/i.test(e.innerText||''));return b?(b.disabled?'disabled':'enabled'):'missing';})()`));
console.log("buttons present:", await ev2(`JSON.stringify([...document.querySelectorAll('button')].map(b=>(b.innerText||'').trim().slice(0,18)).filter(Boolean))`));

try { const bv = await jget("/json/version"); const bws = new WebSocket(bv.webSocketDebuggerUrl);
  await new Promise(r => { const t=setTimeout(r,1500); bws.addEventListener("open",()=>{bws.send(JSON.stringify({id:1,method:"Browser.close",params:{}}));setTimeout(()=>{clearTimeout(t);r();},400);}); bws.addEventListener("error",()=>{clearTimeout(t);r();}); }); } catch {}
setTimeout(()=>process.exit(0),800);
