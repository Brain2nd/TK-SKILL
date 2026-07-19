import {
  addProjectRecipients,
  createProject,
  importCreators,
  setRecipientSender,
  setProjectRecipients,
  updateProject,
  workspaceSnapshot,
} from "../../../db/outreach-store";
import { normalizeCreatorRows, parseCandidateDocument } from "../../../lib/creator-import.mjs";

export const dynamic = "force-dynamic";

function ownerEmail(request: Request) {
  const authenticated = request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase();
  if (authenticated) return authenticated;
  if (["127.0.0.1", "localhost", "::1"].includes(new URL(request.url).hostname)) return "local-operator@loop.local";
  throw new Error("未识别操作用户，拒绝访问项目数据");
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "请求处理失败";
  const status = /不存在|无权/.test(message) ? 404 : /D1 binding/.test(message) ? 503 : 400;
  return Response.json({ ok: false, error: message }, { status });
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const snapshot = await workspaceSnapshot(ownerEmail(request), url.searchParams.get("project_id") || "");
    return Response.json({ ok: true, ...snapshot });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const payload = await request.json() as any;
    const owner = ownerEmail(request);
    let projectId = String(payload.project_id || "");
    let importSummary: any = null;
    if (payload.action === "create_project") {
      projectId = await createProject(owner, payload);
    } else if (payload.action === "update_project") {
      await updateProject(owner, payload);
    } else if (payload.action === "set_recipients") {
      await setProjectRecipients(owner, payload);
    } else if (payload.action === "set_recipient_sender") {
      await setRecipientSender(owner, payload);
    } else if (payload.action === "import_creators") {
      const filename = String(payload.filename || "candidates.json").slice(0, 180);
      const parsed = parseCandidateDocument(String(payload.document || ""), filename);
      const normalized = normalizeCreatorRows(parsed, { source: String(payload.source || filename) });
      if (!normalized.accepted.length) {
        throw new Error(`没有可导入的达人：${normalized.rejected.slice(0, 3).map((item: any) => `第 ${item.row_number} 行 ${item.reason}`).join("；")}`);
      }
      const saved = await importCreators(owner, {
        candidates: normalized.accepted, project_id: projectId, filename, rejected_count: normalized.rejected.length,
      });
      const addedToProject = payload.assign_to_project === true && projectId
        ? await addProjectRecipients(owner, projectId, saved.creator_ids)
        : 0;
      importSummary = {
        contract_version: normalized.contract_version,
        total: normalized.total,
        imported: saved.imported,
        created: saved.created,
        updated: saved.updated,
        rejected: normalized.rejected,
        added_to_project: addedToProject,
      };
    } else {
      return Response.json({ ok: false, error: "不支持的项目操作" }, { status: 400 });
    }
    const snapshot = await workspaceSnapshot(owner, projectId);
    return Response.json({ ok: true, project_id: projectId, batch_id: payload.batch_id || "", import_summary: importSummary, ...snapshot });
  } catch (error) {
    return errorResponse(error);
  }
}
