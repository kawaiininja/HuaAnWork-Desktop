import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const port = process.argv[2] ?? "9223";
const text = process.argv.slice(3).join(" ");
if (!text) {
  console.error("usage: node scripts/spike/probe.mjs <port> <prompt>");
  process.exit(1);
}
const expression = `fetch('/huaanwork/session/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:${JSON.stringify(text)}})}).then(async (response)=>({status:response.status,body:await response.text()}))`;
const child = spawn(process.execPath, [fileURLToPath(new URL("./cdp.mjs", import.meta.url)), port, expression], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
