import { readFileSync } from "node:fs";
import { parseCatalogItem } from "/Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/packages/huaanwork-policy/src/agent-catalog.ts";

function check(label: string, dir: string) {
  const seen = new Set<string>();
  for (const name of ["typo-check", "code-review", "task-orch"]) {
    const raw = JSON.parse(readFileSync(`${dir}/${name}.json`, "utf8"));
    const parsed = parseCatalogItem(raw, seen);
    const verdict = parsed === null ? "PARSE-NULL" : parsed.broken ? `BROKEN: ${parsed.broken.reason}` : `OK(v${parsed.version}, entrypoint=${parsed.entrypoint?.url})`;
    console.log(`[${label}] ${name}: ${verdict}`);
  }
}
check("本地127.0.0.1", "/tmp/a4-precheck/entries");
check("仓内LAN_IP占位", "/Users/amonmiao/Downloads/cursor/agent-catalog-server/entries");
