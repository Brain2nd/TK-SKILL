import {
  applyJobStatus,
  approvePendingBatch,
  approvedBatchForExecution,
  assertSenderIdAvailable,
  createPendingBatch,
  markBatchQueued,
  personalizationRequestForProject,
  senderForOwner,
  setSenderVerification,
  upsertSender,
  workspaceSnapshot,
} from "../../../db/outreach-store";

export const dynamic = "force-dynamic";

const GATEWAY = "http://127.0.0.1:8878";

async function ownerKey(owner: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(owner));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

function ownerEmail(request: Request) {
  const authenticated = request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase();
  if (authenticated) return authenticated;
  if (["127.0.0.1", "localhost", "::1"].includes(new URL(request.url).hostname)) return "local-operator@loop.local";
  throw new Error("未识别操作用户，拒绝访问项目数据");
}

async function gateway(path: string, init: RequestInit = {}, timeoutMs = 7000) {
  let response: Response;
  try {
    response = await fetch(`${GATEWAY}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers || {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error("本地发送网关未运行或暂时不可用");
  }
  const payload = await response.json() as any;
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `发送网关 HTTP ${response.status}`);
  return payload;
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "发送操作失败";
  return Response.json({ ok: false, error: message }, { status: /不存在|not found/.test(message) ? 404 : 400 });
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const owner = ownerEmail(request);
    const tenantKey = await ownerKey(owner);
    const projectId = url.searchParams.get("project_id") || "";
    const jobId = url.searchParams.get("job_id") || "";
    const batchId = url.searchParams.get("batch_id") || "";
    if (jobId && batchId) {
      const result = await gateway(`/jobs/${encodeURIComponent(jobId)}`);
      await applyJobStatus(owner, batchId, result.job);
      return Response.json({ ok: true, job: result.job, ...(await workspaceSnapshot(owner, projectId)) });
    }
    const [health, senders, ai] = await Promise.all([
      gateway("/health").catch((error) => ({ ok: false, error: error.message, circuit: { open: true, reason: "gateway_offline" } })),
      gateway(`/senders?owner_key=${tenantKey}`).catch(() => ({ ok: false, senders: [] })),
      gateway(`/ai?owner_key=${tenantKey}`).catch(() => ({ ok: false, ai: { provider: "anthropic", model: "claude-sonnet-4-6", configured: false, configured_at: "" } })),
    ]);
    return Response.json({
      ok: true,
      operator: { email: owner, mode: owner.endsWith("@loop.local") ? "local" : "workspace" },
      gateway: {
        online: health.ok === true, error: health.error || "", circuit: health.circuit || { open: false }, ai: ai.ai,
        oauth_providers: health.oauth_providers || { gmail_configured: false, outlook_configured: false },
        credentials: health.credentials || "unavailable",
      },
      runtime_senders: senders.senders || [],
      ...(await workspaceSnapshot(owner, projectId)),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const payload = await request.json() as any;
    const owner = ownerEmail(request);
    const tenantKey = await ownerKey(owner);
    if (payload.action === "configure_ai") {
      const result = await gateway("/ai/configure", {
        method: "POST",
        body: JSON.stringify({
          owner_key: tenantKey,
          provider: payload.ai?.provider || "anthropic",
          model: payload.ai?.model || "claude-sonnet-4-6",
          api_key: payload.ai?.api_key || "",
        }),
      });
      return Response.json({ ok: true, ai: result.ai, ...(await workspaceSnapshot(owner, payload.project_id || "")) });
    }
    if (payload.action === "create_batch") {
      const projectId = String(payload.project_id || "");
      const personalizationRequest = await personalizationRequestForProject(owner, projectId);
      const result = await gateway("/personalize-batch", {
        method: "POST",
        body: JSON.stringify({ owner_key: tenantKey, ...personalizationRequest }),
      }, 240000);
      const batchId = await createPendingBatch(owner, projectId, result.personalization);
      return Response.json({ ok: true, project_id: projectId, batch_id: batchId, ...(await workspaceSnapshot(owner, projectId)) });
    }
    if (payload.action === "start_oauth_sender") {
      await assertSenderIdAvailable(owner, String(payload.sender?.id || ""));
      const result = await gateway("/oauth/start", {
        method: "POST",
        body: JSON.stringify({ ...(payload.sender || {}), owner_key: tenantKey }),
      });
      await upsertSender(owner, { ...result.sender, verification_status: "configured" });
      return Response.json({
        ok: true,
        oauth: result.oauth,
        sender: result.sender,
        ...(await workspaceSnapshot(owner, payload.project_id || "")),
      });
    }
    if (payload.action === "configure_sender") {
      await assertSenderIdAvailable(owner, String(payload.sender?.id || ""));
      const result = await gateway("/senders", { method: "POST", body: JSON.stringify({ ...(payload.sender || {}), owner_key: tenantKey }) });
      const sender = result.sender;
      await upsertSender(owner, { ...sender, verification_status: "configured" });
      return Response.json({ ok: true, sender, ...(await workspaceSnapshot(owner, payload.project_id || "")) });
    }
    if (payload.action === "verify_sender") {
      const senderId = String(payload.sender_id || "");
      const storedSender = await senderForOwner(owner, senderId);
      if (!storedSender) throw new Error("发件账户不存在或无权访问");
      const result = await gateway(`/senders/${encodeURIComponent(senderId)}/verify?owner_key=${tenantKey}`, { method: "POST", body: "{}" }, 30000);
      if (result.sender.from_email !== storedSender.from_email || result.sender.from_name !== storedSender.from_name ||
        (result.sender.reply_to_email || "") !== (storedSender.reply_to_email || "")) {
        throw new Error("本地网关发件身份与项目数据库不一致，请重新保存账户配置");
      }
      await setSenderVerification(owner, senderId, "verified");
      return Response.json({ ok: true, sender: result.sender, ...(await workspaceSnapshot(owner, payload.project_id || "")) });
    }
    if (payload.action === "approve_batch") {
      await approvePendingBatch(owner, { ...payload, approved_by: owner });
      return Response.json({ ok: true, ...(await workspaceSnapshot(owner, payload.project_id || "")) });
    }
    if (payload.action === "execute_batch") {
      const batchId = String(payload.batch_id || "");
      const { batch, items } = await approvedBatchForExecution(owner, batchId);
      if (String(payload.confirmation || "").trim() !== batch.name) throw new Error("请输入完整项目名确认正式发送");
      if (payload.live_confirmed !== true) throw new Error("必须明确确认这是一次真实邮件发送");
      const health = await gateway("/health");
      if (health.circuit?.open) throw new Error("全局投递熔断器已打开，必须先人工核对未知投递结果");
      const runId = batch.job_id || `run_${batch.id}`;
      await markBatchQueued(owner, batchId, runId);
      const result = await gateway("/execute", {
        method: "POST",
        body: JSON.stringify({
          run_id: runId,
          batch_id: batch.id,
          project_id: batch.project_id,
          campaign_id: batch.campaign_id,
          approved_hash: batch.payload_hash,
          delay_ms: Math.max(1000, Number(payload.delay_ms || 5000)),
          items,
        }),
      });
      if (result.job.id !== runId) throw new Error("发送网关返回了不匹配的任务 ID");
      await applyJobStatus(owner, batchId, result.job);
      return Response.json({ ok: true, job: result.job, ...(await workspaceSnapshot(owner, batch.project_id)) });
    }
    if (payload.action === "pause_job") {
      const jobId = String(payload.job_id || "");
      const batchId = String(payload.batch_id || "");
      const current = await gateway(`/jobs/${encodeURIComponent(jobId)}`);
      await applyJobStatus(owner, batchId, current.job);
      const result = await gateway(`/jobs/${encodeURIComponent(jobId)}/pause`, { method: "POST", body: "{}" });
      await applyJobStatus(owner, batchId, result.job);
      return Response.json({ ok: true, job: result.job, ...(await workspaceSnapshot(owner, payload.project_id || "")) });
    }
    return Response.json({ ok: false, error: "不支持的发送操作" }, { status: 400 });
  } catch (error) {
    return errorResponse(error);
  }
}
