// lib/config.mjs — 统一配置加载器，从项目根目录的 config.json 读取所有配置
import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = process.env.KOL_OUTREACH_CONFIG || join(__dirname, "../config.json");
const cfg = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
export default cfg;
