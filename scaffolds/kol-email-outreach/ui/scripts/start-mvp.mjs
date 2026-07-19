import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const check = spawnSync(process.execPath, [resolve(root, "scripts", "mvp-preflight.mjs")], { cwd: root, stdio: "inherit" });
if (check.status !== 0) process.exit(check.status || 1);

console.log("\n正在启动中文工作台与安全发送网关…");
console.log("打开地址：http://127.0.0.1:8877/\n");
const gateway = spawn(process.execPath, [resolve(root, "server", "outreach-gateway.mjs")], {
  cwd: root, stdio: "inherit", env: process.env,
});
const ui = spawn(npm, ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", "8877"], {
  cwd: root, stdio: "inherit", env: process.env,
});

let closing = false;
function stop(code = 0) {
  if (closing) return;
  closing = true;
  gateway.kill();
  ui.kill();
  setTimeout(() => process.exit(code), 250).unref();
}
gateway.on("exit", (code) => stop(code || 0));
ui.on("exit", (code) => stop(code || 0));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

