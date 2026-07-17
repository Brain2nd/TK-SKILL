import cfg from "./lib/config.mjs";

const REQUIRED_FIELDS = [
  { field_name: "candidate_id", type: 1 },
  { field_name: "display_name", type: 1 },
  { field_name: "platform", type: 1 },
  { field_name: "profile_snapshot_id", type: 1 },
  { field_name: "screening_run_id", type: 1 },
  { field_name: "screening_decision", type: 1 },
  { field_name: "Do Not Contact", type: 7 },
  { field_name: "Allowed Channels", type: 1 },
  { field_name: "Outreach Pool", type: 1 },
  { field_name: "Quote Amount", type: 2 },
  { field_name: "Quote Currency", type: 1 },
  { field_name: "Quote Details JSON", type: 1 },
  { field_name: "Usage Rights", type: 1 },
  { field_name: "Media Kit", type: 1 },
  { field_name: "First Reply At", type: 5 },
  { field_name: "Contact Status", type: 1 },
  { field_name: "Recent Videos JSON", type: 1 },
  { field_name: "avg_views", type: 1 },
  { field_name: "engagement_rate", type: 2 },
  { field_name: "shop_signals", type: 2 },
  { field_name: "email_source", type: 1 },
  { field_name: "email_verified", type: 7 },
];

async function tenantToken() {
  const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: cfg.feishu_app_id, app_secret: cfg.feishu_app_secret }),
  });
  const data = await response.json();
  if (!response.ok || !data.tenant_access_token) throw new Error(`Feishu auth failed: ${data.msg || response.status}`);
  return data.tenant_access_token;
}

async function listFields(token) {
  const fields = [];
  let pageToken = "";
  do {
    const url = new URL(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${cfg.kol_crm_app_token}/tables/${cfg.kol_tbl_creators}/fields`,
    );
    url.searchParams.set("page_size", "100");
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();
    if (!response.ok || data.code !== 0) throw new Error(`list fields failed: ${data.msg || response.status}`);
    fields.push(...(data.data?.items || []));
    pageToken = data.data?.has_more ? data.data?.page_token || "" : "";
  } while (pageToken);
  return fields;
}

async function createField(token, spec) {
  const response = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${cfg.kol_crm_app_token}/tables/${cfg.kol_tbl_creators}/fields`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(spec),
    },
  );
  const data = await response.json();
  if (!response.ok || data.code !== 0) throw new Error(`create ${spec.field_name} failed: ${data.msg || response.status}`);
  return data.data?.field;
}

async function main() {
  const execute = process.argv.includes("--execute");
  for (const key of ["feishu_app_id", "feishu_app_secret", "kol_crm_app_token", "kol_tbl_creators"]) {
    if (!cfg[key] || String(cfg[key]).startsWith("YOUR_")) throw new Error(`config.json missing ${key}`);
  }
  const token = await tenantToken();
  const existing = new Set((await listFields(token)).map(field => field.field_name));
  const missing = REQUIRED_FIELDS.filter(field => !existing.has(field.field_name));
  console.log(JSON.stringify({ mode: execute ? "execute" : "dry-run", existing: existing.size, missing }, null, 2));
  if (!execute || missing.length === 0) return;
  for (const spec of missing) {
    await createField(token, spec);
    console.error(`created field: ${spec.field_name}`);
  }
}

main().catch(error => {
  console.error(`Setup failed: ${error.message}`);
  process.exit(1);
});
