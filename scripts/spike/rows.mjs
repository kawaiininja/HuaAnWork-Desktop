import { createRequire } from "node:module";

const require = createRequire(new URL("../../dsh-plugin-huaanwork/package.json", import.meta.url));
// composeEntries 由 dsh-app-boot 导出（profile.ts/profile.spec.ts 同源）；
// cordis-plugin-loader 不导出它（实测 undefined），写错包名会在调用处 TypeError。
const { composeEntries } = require("@deepseek-ai/dsh-app-boot");
const { prepareDesktopProfile } = await import(new URL("../../dsh-plugin-huaanwork/lib/profile.js", import.meta.url).href);

const home = process.env.DSH_HOME;
if (!home) {
  console.error("DSH_HOME is required");
  process.exit(1);
}
const prepared = prepareDesktopProfile(process.env.DSH_TELEMETRY_DISABLED, home, process.platform);
const rows = new Map(composeEntries([prepared.patches]).map((row) => [row.id, row]));
const shell = process.platform === "win32" ? "tool-pwsh" : "tool-bash";
for (const id of ["tool-fs", "tool-fs-search", shell, "jobs", "tool-jobs"]) {
  const row = rows.get(id);
  console.log(JSON.stringify({ id, disabled: row?.disabled ?? null, config: row?.config ?? null }));
}
