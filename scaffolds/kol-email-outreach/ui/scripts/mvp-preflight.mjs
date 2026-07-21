import { access } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const required = [
  "app/page.tsx", "server/outreach-gateway.mjs", "db/schema.ts", ".openai/hosting.json",
];
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Node.js 版本过低：当前 ${process.versions.node}，需要 22.13.0 或更高版本。`);
  process.exit(1);
}
for (const file of required) {
  try { await access(resolve(root, file)); }
  catch { console.error(`缺少MVP运行文件：${file}`); process.exit(1); }
}

const providers = {
  Gmail: Boolean(process.env.LOOP_GOOGLE_OAUTH_CLIENT_ID),
  Outlook: Boolean(process.env.LOOP_MICROSOFT_OAUTH_CLIENT_ID),
};
console.log("LOOP MVP 启动检查通过");
console.log(`- Node.js ${process.versions.node}`);
console.log(`- Gmail OAuth：${providers.Gmail ? "已配置" : "未配置（仍可使用其他邮箱）"}`);
console.log(`- Outlook OAuth：${providers.Outlook ? "已配置" : "未配置（仍可使用其他邮箱）"}`);
console.log("- 默认安全模式：先生成、再审批、最后二次确认发送");

