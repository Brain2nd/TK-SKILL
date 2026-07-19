"use client";

import { useEffect, useMemo, useState } from "react";

type View = "projects" | "approvals" | "replies" | "senders" | "safety";
type Notice = { tone: "success" | "error" | "info"; text: string } | null;

const DEFAULT_SUBJECT = "Paid TikTok Shop short-form video opportunity";
const DEFAULT_BODY = `Hi!

{{personalized_hook}}

We have a paid TikTok Shop short-form video posting opportunity.

We will provide the video for you, and you only need to post it on your TikTok account and add the TikTok Shop product link. You will receive €20 for the post.

Here is a sample video for reference: https://vm.tiktok.com/ZNRoT8PuT/

Would you be interested in collaborating with us?

{{sender_name}}`;

const navItems: { id: View; label: string; icon: string }[] = [
  { id: "projects", label: "项目中心", icon: "⌁" },
  { id: "approvals", label: "审批与发送", icon: "✓" },
  { id: "replies", label: "回复与报价", icon: "↳" },
  { id: "senders", label: "邮箱账户", icon: "@" },
  { id: "safety", label: "安全与审计", icon: "◇" },
];

const projectStatus: Record<string, string> = {
  draft: "草稿",
  pending_approval: "待审批",
  approved: "已批准",
  queued: "已排队",
  sending: "发送中",
  paused: "已暂停",
  completed: "已完成",
  delivery_unknown: "投递未知",
  failed: "失败",
};

const batchStatus: Record<string, string> = { ...projectStatus, pending: "待审批" };

const traitLabels: Record<string, string> = {
  home_decor: "家居装饰", fashion: "时尚穿搭", beauty: "美妆", ugc_creator: "UGC 创作者",
  skincare: "护肤", product_reviews: "产品测评", travel: "旅行", creator_education: "创作者教育",
  brand_storytelling: "品牌故事", ugc_manager: "UGC 管理", versatile_brand_content: "品牌内容",
};

function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value || 0));
}

function statusTone(status = "") {
  if (["completed", "sent", "verified"].includes(status)) return "green";
  if (["approved", "queued", "sending"].includes(status)) return "blue";
  if (["delivery_unknown", "failed", "paused"].includes(status)) return "red";
  return "amber";
}

function Avatar({ name, tone = "mint" }: { name: string; tone?: string }) {
  const value = String(name || "达人").replace(/^@/, "");
  return <span className={`avatar ${tone}`}>{value.slice(0, 2).toUpperCase()}</span>;
}

function Pill({ children, tone = "neutral" }: { children: React.ReactNode; tone?: string }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

function Modal({ title, children, close, wide = false }: { title: string; children: React.ReactNode; close: () => void; wide?: boolean }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <section className={`modal-card ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <header><div><p className="eyebrow">LOOP CREATOR OS</p><h2>{title}</h2></div><button className="icon-button" onClick={close} aria-label="关闭">×</button></header>
        {children}
      </section>
    </div>
  );
}

function Empty({ title, text, action }: { title: string; text: string; action?: React.ReactNode }) {
  return <section className="panel empty-state"><div className="empty-symbol">↳</div><h2>{title}</h2><p>{text}</p>{action}</section>;
}

async function readResponse(response: Response) {
  const payload = await response.json();
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `请求失败（${response.status}）`);
  return payload;
}

function ProjectCard({ project, active, select }: { project: any; active: boolean; select: () => void }) {
  return (
    <button className={`project-card ${active ? "active" : ""}`} onClick={select}>
      <div className="project-card-top"><Pill tone={statusTone(project.status)}>{projectStatus[project.status] || project.status}</Pill><span>{project.market || "未设地区"}</span></div>
      <h3>{project.name}</h3>
      <p>{project.brand_name || "未设品牌"} · {project.offer_currency} {project.offer_amount}</p>
      <div className="project-progress"><span style={{ width: `${Math.min(100, project.target_count ? project.recipient_count / project.target_count * 100 : 0)}%` }} /></div>
      <div className="project-card-foot"><span>达人 {project.recipient_count}/{project.target_count}</span><span>已发送 {project.sent_count}</span><span className={project.unknown_count ? "danger-text" : ""}>未知 {project.unknown_count}</span></div>
    </button>
  );
}

function CreateProjectModal({ workspace, close, submit, busy }: any) {
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [market, setMarket] = useState("ES");
  const [offer, setOffer] = useState(20);
  const [currency, setCurrency] = useState("EUR");
  const [count, setCount] = useState(Math.min(10, workspace.creators.length));
  const [senderId, setSenderId] = useState(workspace.senders.find((sender: any) => sender.verification_status === "verified")?.id || "");
  const [subject, setSubject] = useState(DEFAULT_SUBJECT);
  const [body, setBody] = useState(DEFAULT_BODY);
  const [selected, setSelected] = useState<string[]>(workspace.creators.slice(0, count).map((creator: any) => creator.id));

  function selectTop(nextCount = count) {
    const safeCount = Math.max(1, Math.min(workspace.creators.length, Number(nextCount || 1)));
    setCount(safeCount);
    setSelected(workspace.creators.slice(0, safeCount).map((creator: any) => creator.id));
  }

  function toggleCreator(creatorId: string) {
    setSelected((current) => current.includes(creatorId) ? current.filter((id) => id !== creatorId) : [...current, creatorId]);
  }

  return (
    <Modal title="新建首次建联项目" close={close} wide>
      <form className="wizard" onSubmit={(event) => {
        event.preventDefault();
        submit({
          action: "create_project", name, brand_name: brand, market, offer_amount: offer,
          offer_currency: currency, target_count: count, default_sender_id: senderId,
          subject_template: subject, body_template: body, creator_ids: selected,
        });
      }}>
        <div className="wizard-step"><span>01</span><div><h3>项目信息</h3><p>为每个 Campaign 建立独立达人名单和发送状态。</p></div></div>
        <div className="form-grid three">
          <label><span>项目名称</span><input required value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：法国美妆新品首发" /></label>
          <label><span>品牌</span><input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="品牌名" /></label>
          <label><span>地区</span><input value={market} onChange={(e) => setMarket(e.target.value)} placeholder="ES / FR / DE" /></label>
          <label><span>固定报价</span><input type="number" min="0" value={offer} onChange={(e) => setOffer(Number(e.target.value))} /></label>
          <label><span>币种</span><select value={currency} onChange={(e) => setCurrency(e.target.value)}><option>EUR</option><option>USD</option><option>GBP</option></select></label>
          <label><span>默认发件邮箱</span><select value={senderId} onChange={(e) => setSenderId(e.target.value)}><option value="">稍后配置</option>{workspace.senders.map((sender: any) => <option key={sender.id} value={sender.id}>{sender.label} · {sender.from_email}</option>)}</select></label>
        </div>

        <div className="wizard-step"><span>02</span><div><h3>达人和发送数量</h3><p>明确这个项目给谁发、总共发几封。</p></div><div className="step-action"><input className="count-input" type="number" min="1" max={workspace.creators.length} value={count} onChange={(e) => selectTop(Number(e.target.value))}/><button type="button" className="secondary-button" onClick={() => selectTop()}>按均播选 Top {count}</button></div></div>
        <div className="creator-picker">
          {workspace.creators.map((creator: any) => <label className={selected.includes(creator.id) ? "selected" : ""} key={creator.id}><input type="checkbox" checked={selected.includes(creator.id)} onChange={() => toggleCreator(creator.id)} /><Avatar name={creator.handle}/><span><b>@{creator.handle}</b><small>{formatNumber(creator.followers)} 粉丝 · {formatNumber(creator.avg_views)} 均播</small></span></label>)}
        </div>
        <div className={`selection-count ${selected.length === count ? "ok" : "bad"}`}>已选 {selected.length} / 目标 {count} 位达人</div>

        <div className="wizard-step"><span>03</span><div><h3>英文邮件模板</h3><p>画像钩子和发件人签名会在生成批次时替换。</p></div></div>
        <div className="form-stack">
          <label><span>主题</span><input required value={subject} onChange={(e) => setSubject(e.target.value)} lang="en" /></label>
          <label><span>正文</span><textarea required rows={12} value={body} onChange={(e) => setBody(e.target.value)} lang="en" /></label>
          <small>必须保留 <code>{"{{personalized_hook}}"}</code> 和 <code>{"{{sender_name}}"}</code>。商业条款由模板正文控制。</small>
        </div>
        <footer className="modal-actions"><button type="button" className="secondary-button" onClick={close}>取消</button><button className="primary-button" disabled={busy || selected.length !== count}>{busy ? "正在创建…" : `创建项目并分配 ${selected.length} 位达人`}</button></footer>
      </form>
    </Modal>
  );
}

function RecipientModal({ workspace, project, close, submit, busy }: any) {
  const initial = workspace.recipients.map((recipient: any) => recipient.creator_id);
  const [selected, setSelected] = useState<string[]>(initial);
  function toggle(id: string) { setSelected((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]); }
  return (
    <Modal title={`调整「${project.name}」达人名单`} close={close} wide>
      <div className="creator-picker tall">
        {workspace.creators.map((creator: any) => <label className={selected.includes(creator.id) ? "selected" : ""} key={creator.id}><input type="checkbox" checked={selected.includes(creator.id)} onChange={() => toggle(creator.id)} /><Avatar name={creator.handle}/><span><b>@{creator.handle}</b><small>{formatNumber(creator.followers)} 粉丝 · {formatNumber(creator.avg_views)} 均播</small></span></label>)}
      </div>
      <footer className="modal-actions"><span>将发送给 {selected.length} 位达人</span><button className="secondary-button" onClick={close}>取消</button><button className="primary-button" disabled={busy || !selected.length} onClick={() => submit({ action: "set_recipients", project_id: project.id, creator_ids: selected })}>保存达人分配</button></footer>
    </Modal>
  );
}

function ProjectWorkspace({ workspace, project, busy, postWorkspace, openRecipients, openApprovals }: any) {
  const [name, setName] = useState(project.name);
  const [brand, setBrand] = useState(project.brand_name);
  const [market, setMarket] = useState(project.market);
  const [offer, setOffer] = useState(project.offer_amount);
  const [currency, setCurrency] = useState(project.offer_currency);
  const [senderId, setSenderId] = useState(project.default_sender_id);
  const [subject, setSubject] = useState(project.subject_template);
  const [body, setBody] = useState(project.body_template);
  const sentLocked = ["queued", "sending", "paused", "failed", "completed", "delivery_unknown"].includes(project.status);

  const sender = workspace.senders.find((item: any) => item.id === senderId);
  return (
    <>
      <section className="metric-grid">
        <article className="metric-card accent-card"><span className="metric-label">项目达人</span><strong>{project.recipient_count}</strong><span className="metric-foot positive">目标 {project.target_count} 位</span></article>
        <article className="metric-card"><span className="metric-label">待发送</span><strong>{Math.max(0, project.recipient_count - project.sent_count)}</strong><span className="metric-foot">由审批批次冻结</span></article>
        <article className="metric-card"><span className="metric-label">已发送</span><strong>{project.sent_count}</strong><span className="metric-foot positive">不可撤回</span></article>
        <article className="metric-card"><span className="metric-label">投递未知</span><strong>{project.unknown_count}</strong><span className={`metric-foot ${project.unknown_count ? "warning" : "positive"}`}>{project.unknown_count ? "全局已暂停" : "熔断器正常"}</span></article>
      </section>

      <section className="project-detail-grid">
        <article className="panel project-settings">
          <div className="section-title-row compact"><div><p className="eyebrow">PROJECT SETTINGS</p><h2>项目与邮件设置</h2></div><Pill tone={statusTone(project.status)}>{projectStatus[project.status] || project.status}</Pill></div>
          <div className="form-grid three">
            <label><span>项目名称</span><input disabled={sentLocked} value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label><span>品牌</span><input disabled={sentLocked} value={brand} onChange={(e) => setBrand(e.target.value)} /></label>
            <label><span>市场</span><input disabled={sentLocked} value={market} onChange={(e) => setMarket(e.target.value)} /></label>
            <label><span>报价</span><input disabled={sentLocked} type="number" value={offer} onChange={(e) => setOffer(Number(e.target.value))}/></label>
            <label><span>币种</span><select disabled={sentLocked} value={currency} onChange={(e) => setCurrency(e.target.value)}><option>EUR</option><option>USD</option><option>GBP</option></select></label>
            <label><span>项目默认发件邮箱</span><select disabled={sentLocked} value={senderId} onChange={(e) => setSenderId(e.target.value)}><option value="">未配置</option>{workspace.senders.map((item: any) => <option key={item.id} value={item.id}>{item.label} · {item.from_email} · {item.verification_status === "verified" ? "已验证" : "待验证"}</option>)}</select></label>
          </div>
          {!senderId && <div className="inline-warning">生成审批批次前必须选择一个已验证发件邮箱。</div>}
          {senderId && sender?.verification_status !== "verified" && <div className="inline-warning">{sender?.from_email || "该邮箱"} 尚未验证发件连接，不能进入正式审批。</div>}
          <div className="form-stack template-editor">
            <label><span>英文主题</span><input disabled={sentLocked} value={subject} onChange={(e) => setSubject(e.target.value)} lang="en" /></label>
            <label><span>英文正文</span><textarea disabled={sentLocked} rows={13} value={body} onChange={(e) => setBody(e.target.value)} lang="en" /></label>
          </div>
          <div className="panel-actions">
            <small>{sentLocked ? "项目已有发送记录，首次建联快照已锁定。" : "修改模板或发件邮箱会自动使旧审批失效。"}</small>
            <button className="primary-button" disabled={busy || sentLocked} onClick={() => postWorkspace({
              action: "update_project", project_id: project.id, name, brand_name: brand, market,
              offer_amount: offer, offer_currency: currency, target_count: project.recipient_count,
              default_sender_id: senderId, subject_template: subject, body_template: body,
            })}>保存项目设置</button>
          </div>
        </article>

        <aside className="panel project-summary">
          <p className="eyebrow">SEND PLAN</p><h2>发送计划</h2>
          <div><span>Campaign ID</span><code>{project.campaign_id}</code></div>
          <div><span>默认发件人</span><b>{sender ? `${sender.from_name} · ${sender.from_email}` : "未配置"}</b></div>
          <div><span>邮件数量</span><b>{project.recipient_count} 封</b></div>
          <div><span>自动 Follow-up</span><b>关闭</b></div>
          <div><span>发送方式</span><b>顺序队列 · 最低 1 秒间隔</b></div>
          <button className="secondary-button full" onClick={openRecipients} disabled={sentLocked}>调整达人名单</button>
          <button className="primary-button full" onClick={openApprovals}>进入审批与发送</button>
        </aside>
      </section>

      <section className="panel recipients-panel">
        <div className="section-title-row compact"><div><p className="eyebrow">RECIPIENT ALLOCATION</p><h2>本项目给谁发、由谁发</h2></div><button className="text-button" onClick={openRecipients} disabled={sentLocked}>调整名单</button></div>
        <div className="table-wrap"><table><thead><tr><th>达人</th><th>画像</th><th>粉丝 / 均播</th><th>收件邮箱</th><th>发件邮箱</th></tr></thead><tbody>
          {workspace.recipients.map((recipient: any, index: number) => <tr key={recipient.id}>
            <td><div className="creator-cell"><Avatar name={recipient.handle} tone={index % 2 ? "blue" : "mint"}/><div><b>@{recipient.handle}</b><small>{recipient.city || recipient.country}</small></div></div></td>
            <td><span className="category">{(recipient.traits || []).slice(0, 2).map((trait: string) => traitLabels[trait] || trait.replace("_", " ")).join(" · ") || "—"}</span><small>{(recipient.engagement_rate * 100).toFixed(1)}% 互动率</small></td>
            <td><b>{formatNumber(recipient.followers)}</b><small>{formatNumber(recipient.avg_views)} 平均播放</small></td>
            <td><span className="email-cell">{recipient.contact_email}</span></td>
            <td><select className="inline-select" disabled={busy || sentLocked} value={recipient.sender_override_id || ""} onChange={(e) => postWorkspace({ action: "set_recipient_sender", project_id: project.id, recipient_id: recipient.id, sender_id: e.target.value })}><option value="">使用项目默认邮箱</option>{workspace.senders.map((item: any) => <option key={item.id} value={item.id}>{item.from_email}</option>)}</select></td>
          </tr>)}
        </tbody></table></div>
      </section>
    </>
  );
}

function ProjectCenter({ workspace, project, busy, postWorkspace, selectProject, openCreate, openRecipients, openApprovals }: any) {
  return (
    <>
      <div className="page-heading"><div><p className="eyebrow">CAMPAIGN PROJECTS</p><h1>首次建联项目中心</h1><p className="lede">每个项目独立管理达人名单、发送数量、英文模板、发件邮箱和审批批次。</p></div><button className="primary-button" onClick={openCreate}>＋ 新建项目</button></div>
      <div className="project-strip">{workspace.projects.map((item: any) => <ProjectCard key={item.id} project={item} active={item.id === project?.id} select={() => selectProject(item.id)}/>)}</div>
      {project ? <ProjectWorkspace key={project.id} workspace={workspace} project={project} busy={busy} postWorkspace={postWorkspace} openRecipients={openRecipients} openApprovals={openApprovals}/> : <Empty title="还没有项目" text="新建一个项目并分配达人，系统会为每个项目独立记录发送状态。" />}
    </>
  );
}

function Approvals({ workspace, project, busy, postWorkspace, postSend, job }: any) {
  const batch = workspace.batches[0];
  const items = batch ? workspace.batch_items.filter((item: any) => item.batch_id === batch.id) : [];
  const [mailIndex, setMailIndex] = useState(0);
  const [confirmation, setConfirmation] = useState("");
  const [acceptWarnings, setAcceptWarnings] = useState(false);
  const [reviewedWarningIds, setReviewedWarningIds] = useState<string[]>([]);
  const [liveConfirmed, setLiveConfirmed] = useState(false);
  const item = items[Math.min(mailIndex, Math.max(0, items.length - 1))];
  const warningCount = items.filter((row: any) => row.review_warnings?.length).length;
  const warningItemIds = items.filter((row: any) => row.review_warnings?.length).map((row: any) => row.id);
  const duplicateRecipientCount = items.length - new Set(items.map((row: any) => String(row.recipient_email).toLowerCase())).size;
  const allocations = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of items) counts.set(row.from_email, (counts.get(row.from_email) || 0) + 1);
    return [...counts.entries()];
  }, [items]);
  if (!project) return <Empty title="请先选择项目" text="回到项目中心选择要审批的 Campaign。" />;
  if (!batch) {
    const aiReady = workspace.gateway?.ai?.configured === true;
    const senderReady = workspace.senders.some((sender: any) => sender.verification_status === "verified");
    const blocker = !aiReady
      ? "请先在“邮箱账户”页面配置只写 AI API Key。"
      : !senderReady
        ? "请先添加并验证至少一个发件邮箱，再为项目选择默认邮箱。"
        : "AI 将只生成每位达人的个性化开场，母模板商业条款不会交给模型改写。";
    return (
      <><div className="page-heading"><div><p className="eyebrow">APPROVAL & SEND</p><h1>审批与发送</h1><p className="lede">先用达人公开字段生成个性化开场，再把完整邮件冻结成不可变批次逐封审核。</p></div></div>
      <Empty title="尚未生成审批批次" text={`${blocker} 生成后会冻结每封邮件的 From、To、Subject、Body 和幂等键。`} action={<button className="primary-button" disabled={busy || !aiReady || !senderReady} onClick={() => postSend({ action: "create_batch", project_id: project.id })}>{busy ? "AI 正在逐封生成…" : `AI 生成 ${project.recipient_count} 封审批邮件`}</button>}/></>
    );
  }

  const running = ["queued", "sending"].includes(batch.status);
  const completed = ["completed", "paused", "delivery_unknown", "failed"].includes(batch.status);
  const activeJob = job?.batch_id === batch.id ? job : null;
  const counts = activeJob?.counts || { sent: batch.sent_count, failed: batch.failed_count, delivery_unknown: batch.unknown_count, skipped_existing: batch.skipped_count };
  return (
    <>
      <div className="page-heading"><div><p className="eyebrow">APPROVAL BATCH / {batch.id.slice(-8).toUpperCase()}</p><h1>审批与发送</h1><p className="lede">正式发送只提交一次批次入队请求；服务端逐封处理，不会由浏览器循环发送。</p></div><Pill tone={statusTone(batch.status)}>{batchStatus[batch.status] || batch.status}</Pill></div>

      {batch.status === "delivery_unknown" && <section className="critical-banner"><b>投递结果未知，所有后续发送已暂停</b><p>不要重新发送。请先检查发件箱 Sent 文件夹或邮件服务商记录，再人工处理。</p></section>}

      <section className="approval-banner pending">
        <div className="approval-icon">{batch.status === "pending" ? "…" : batch.status === "approved" ? "✓" : running ? "↗" : completed ? "■" : "✓"}</div>
        <div><b>{batch.status === "pending" ? "批次等待人工审批" : batch.status === "approved" ? "内容已锁定，等待正式发送确认" : running ? "批次正在安全发送队列中" : "本次批次已有执行结果"}</b><p>{batch.item_count} 封邮件 · SHA-256 {batch.payload_hash.slice(0, 18)}… · 修改项目内容会使审批失效</p></div>
        <div className="allocation-list">{allocations.map(([email, count]) => <span key={email}><b>{email}</b><small>{count} 封</small></span>)}</div>
      </section>

      {(running || completed) && <section className="reply-kpis send-progress">
        <div><span>队列总数</span><strong>{batch.item_count}</strong><small>批次不可变</small></div>
        <div><span>已发送</span><strong className="text-green">{counts.sent || 0}</strong><small>已获明确成功</small></div>
        <div><span>明确失败</span><strong>{counts.failed || 0}</strong><small>不会自动重试</small></div>
        <div><span>投递未知</span><strong className={counts.delivery_unknown ? "danger-text" : ""}>{counts.delivery_unknown || 0}</strong><small>命中即全局熔断</small></div>
      </section>}

      <section className="batch-layout">
        <article className="panel mail-preview">
          <div className="mail-toolbar"><div><span className="mail-dot red"></span><span className="mail-dot yellow"></span><span className="mail-dot green"></span></div><div className="mail-pager"><button aria-label="上一封" disabled={mailIndex === 0} onClick={() => setMailIndex((value) => value - 1)}>‹</button><span>邮件 {mailIndex + 1} / {items.length}</span><button aria-label="下一封" disabled={mailIndex >= items.length - 1} onClick={() => setMailIndex((value) => value + 1)}>›</button></div><Pill tone="blue">画像个性化</Pill></div>
          {item && <><div className="mail-meta"><Avatar name={item.handle}/><div><b>{item.from_name}</b><p>From: {item.from_email}{item.reply_to_email ? ` · Reply-To: ${item.reply_to_email}` : ""}</p></div><div className="mail-to"><small>收件人</small><span>{item.recipient_email}</span></div></div><div className="mail-subject"><small>邮件主题</small><h2 lang="en">{item.subject}</h2></div><div className="mail-body" lang="en">{item.body.split("\n").filter(Boolean).map((paragraph: string, index: number) => <p key={index}>{paragraph}</p>)}</div>{item.review_warnings?.length > 0 && <div className="warning-review"><b>本封需要人工核对</b><ul>{item.review_warnings.map((warning: unknown, index: number) => <li key={index}>{typeof warning === "string" ? warning : JSON.stringify(warning)}</li>)}</ul><button className={reviewedWarningIds.includes(item.id) ? "secondary-button reviewed" : "secondary-button"} onClick={() => setReviewedWarningIds((current) => current.includes(item.id) ? current : [...current, item.id])}>{reviewedWarningIds.includes(item.id) ? "✓ 已核对本封警告" : "标记本封已核对"}</button></div>}<div className="mail-footer"><span>幂等键 {item.idempotency_key}</span><span>{item.review_warnings?.length || 0} 项人工审核</span></div></>}
        </article>

        <aside className="batch-side">
          <article className="panel checklist"><p className="eyebrow">PRE-FLIGHT CHECKS</p><h2>发送前检查</h2>{[
            ["项目达人", `${items.length} 位`], ["发件邮箱", `${allocations.length} 个`], ["重复收件人", String(duplicateRecipientCount)],
            ["自动 Follow-up", "已关闭"], ["人工审核警告", `${warningCount} 封`], ["网络重试", "结果未知时禁止"],
          ].map(([label, value]) => <div className="check-row" key={label}><span className="checkmark">✓</span><span>{label}</span><b>{value}</b></div>)}</article>

          {batch.status === "pending" && <article className="panel confirmation-box"><p className="eyebrow">HUMAN APPROVAL</p><h2>批准不可变批次</h2><p>逐封确认后输入完整项目名：</p><input value={confirmation} onChange={(e) => setConfirmation(e.target.value)} placeholder={project.name}/>{warningCount > 0 && <p className="review-progress">含警告邮件已核对 {reviewedWarningIds.filter((id) => warningItemIds.includes(id)).length}/{warningCount} 封</p>}<label className="check-label"><input type="checkbox" checked={acceptWarnings} disabled={warningCount > 0 && warningItemIds.some((id: string) => !reviewedWarningIds.includes(id))} onChange={(e) => setAcceptWarnings(e.target.checked)}/>我确认已逐封核对全部人工警告</label><button className="primary-button full" disabled={busy || confirmation !== project.name || duplicateRecipientCount > 0 || (warningCount > 0 && (!acceptWarnings || warningItemIds.some((id: string) => !reviewedWarningIds.includes(id))))} onClick={() => postSend({ action: "approve_batch", project_id: project.id, batch_id: batch.id, confirmation, accept_warnings: acceptWarnings, reviewed_warning_item_ids: reviewedWarningIds })}>批准并锁定批次</button></article>}

          {(batch.status === "approved" || (batch.status === "queued" && !activeJob)) && <article className="panel confirmation-box live-box"><p className="eyebrow">LIVE SEND</p><h2>{batch.status === "queued" ? "重新提交同一安全任务" : "正式加入发送队列"}</h2><p>{batch.status === "queued" ? "数据库已保留唯一 run_id，但网关尚未返回任务；再次提交仍绑定同一批次，不会创建第二个运行实例。" : "发送后无法撤回。重复点击只会返回同一个运行实例。"}</p><input value={confirmation} onChange={(e) => setConfirmation(e.target.value)} placeholder={`输入：${project.name}`}/><label className="check-label"><input type="checkbox" checked={liveConfirmed} onChange={(e) => setLiveConfirmed(e.target.checked)}/>我确认立即发送 {batch.item_count} 封真实邮件</label><button className="danger-button full" disabled={busy || confirmation !== project.name || !liveConfirmed || workspace.gateway?.online !== true || workspace.gateway?.circuit?.open} onClick={() => postSend({ action: "execute_batch", project_id: project.id, batch_id: batch.id, confirmation, live_confirmed: true, delay_ms: 5000 })}>{batch.status === "queued" ? "重新提交同一 run_id" : `正式入队发送 ${batch.item_count} 封`}</button></article>}

          {running && activeJob && <article className="panel confirmation-box"><p className="eyebrow">QUEUE CONTROL</p><h2>发送队列运行中</h2><p>暂停只影响尚未发送的邮件，已经发出的邮件不能撤回。</p><button className="secondary-button full" disabled={busy} onClick={() => postSend({ action: "pause_job", project_id: project.id, batch_id: batch.id, job_id: batch.job_id })}>暂停剩余发送</button></article>}
        </aside>
      </section>
    </>
  );
}

function SenderAccounts({ workspace, busy, postSend }: any) {
  const [editingId, setEditingId] = useState("");
  const [provider, setProvider] = useState("gmail");
  const [label, setLabel] = useState("Vira Gmail");
  const [fromName, setFromName] = useState("Vira");
  const [fromEmail, setFromEmail] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [host, setHost] = useState("smtp.gmail.com");
  const [port, setPort] = useState(465);
  const [secure, setSecure] = useState(true);
  const [dailyCap, setDailyCap] = useState(50);
  const [password, setPassword] = useState("");
  const [aiModel, setAiModel] = useState(workspace.gateway?.ai?.model || "claude-sonnet-4-6");
  const [aiKey, setAiKey] = useState("");
  const runtimeById = new Map((workspace.runtime_senders || []).map((sender: any) => [sender.id, sender]));
  const providerLabels: Record<string, string> = { gmail: "Gmail API", outlook: "Microsoft Graph", custom: "自定义 SMTP" };

  function chooseProvider(value: string) {
    setProvider(value);
    if (value === "gmail") { setLabel((current) => current || "Gmail"); setHost("gmail.googleapis.com"); setPort(443); setSecure(true); }
    if (value === "outlook") { setLabel((current) => current || "Outlook"); setHost("graph.microsoft.com"); setPort(443); setSecure(true); }
    if (value === "custom") { setHost("smtp.example.com"); setPort(465); setSecure(true); }
  }
  function edit(sender: any) {
    setEditingId(sender.id); setLabel(sender.label); setFromName(sender.from_name); setFromEmail(sender.from_email);
    setReplyTo(sender.reply_to_email || ""); setHost(sender.smtp_host); setPort(sender.smtp_port); setSecure(Boolean(sender.secure));
    setDailyCap(sender.daily_cap); setPassword(""); setProvider(sender.provider || (sender.auth_mode === "oauth" ? "gmail" : "custom"));
  }
  async function submitSender(event: React.FormEvent) {
    event.preventDefault();
    const sender = {
      id: editingId || undefined, label, from_name: fromName, from_email: fromEmail,
      reply_to_email: replyTo, smtp_host: host, smtp_port: port, secure, daily_cap: dailyCap,
    };
    if (provider === "custom") {
      await postSend({ action: "configure_sender", sender: { ...sender, password } });
      setPassword("");
      return;
    }
    const popup = window.open("about:blank", `loop-oauth-${provider}`, "popup,width=560,height=720");
    if (!popup) throw new Error("浏览器阻止了授权窗口，请允许本站打开弹窗后重试");
    popup.document.title = "正在连接邮箱";
    popup.document.body.innerHTML = '<p style="font:16px system-ui;padding:32px">正在准备官方授权页面…</p>';
    let finished = false;
    let poll = 0;
    const finish = async (senderId: string) => {
      if (finished) return;
      finished = true;
      window.removeEventListener("message", onMessage);
      if (poll) window.clearInterval(poll);
      await postSend({ action: "verify_sender", sender_id: senderId });
    };
    const onMessage = (message: MessageEvent) => {
      if (message.origin !== "http://127.0.0.1:8878" || message.data?.type !== "loop-oauth-complete") return;
      finish(String(message.data.sender_id || "")).catch(() => {});
    };
    window.addEventListener("message", onMessage);
    try {
      const result = await postSend({ action: "start_oauth_sender", sender: { ...sender, provider } });
      popup.location.href = result.oauth.authorization_url;
      poll = window.setInterval(() => {
        if (!popup.closed || finished) return;
        finish(String(result.oauth.sender_id || "")).catch(() => {});
      }, 800);
    } catch (error) {
      window.removeEventListener("message", onMessage);
      if (poll) window.clearInterval(poll);
      popup.close();
      throw error;
    }
  }
  return (
    <>
      <div className="page-heading"><div><p className="eyebrow">SENDER ACCOUNTS</p><h1>邮箱账户</h1><p className="lede">Gmail 和 Outlook 只需填写邮箱并完成一次官方授权；自定义邮箱仍可使用 SMTP。令牌和密码都不会写入项目数据库。</p></div><Pill tone={workspace.gateway?.online ? "green" : "red"}>{workspace.gateway?.online ? "本地网关在线" : "发送网关离线"}</Pill></div>
      <section className="sender-layout">
        <article className="panel sender-list"><div className="section-title-row compact"><div><p className="eyebrow">VERIFIED IDENTITIES</p><h2>已配置发件身份</h2></div><span>{workspace.senders.length} 个</span></div>
          {workspace.senders.length ? workspace.senders.map((sender: any) => { const runtime: any = runtimeById.get(sender.id); const oauth = sender.auth_mode === "oauth"; return <div className="sender-row" key={sender.id}><Avatar name={sender.from_name}/><div><b>{sender.label}</b><span>{sender.from_name} &lt;{sender.from_email}&gt;</span><small>{providerLabels[sender.provider] || "自定义 SMTP"} · 今日 {runtime?.sent_today || 0}/{sender.daily_cap}</small></div><div className="sender-status"><Pill tone={runtime?.verified ? "green" : runtime?.configured ? "amber" : "red"}>{runtime?.verified ? "连接已验证" : runtime?.configured ? "待验证" : oauth ? "需重新授权" : "需重新输入密码"}</Pill><button className="text-button" onClick={() => edit(sender)}>{oauth ? "重新连接" : "编辑"}</button><button className="text-button" disabled={busy || !runtime?.configured} onClick={() => postSend({ action: "verify_sender", sender_id: sender.id })}>测试连接</button></div></div>}) : <div className="mini-empty">尚未添加发件邮箱。连接并验证后，项目才能生成审批批次。</div>}
        </article>
        <article className="panel sender-form"><p className="eyebrow">{editingId ? "RECONFIGURE" : "ADD SENDER"}</p><h2>{editingId ? "重新配置邮箱" : "添加发件邮箱"}</h2>
          <form onSubmit={submitSender}>
            <div className="form-grid two"><label><span>连接方式</span><select value={provider} onChange={(e) => chooseProvider(e.target.value)}><option value="gmail">Gmail API（推荐）</option><option value="outlook">Outlook / Microsoft 365</option><option value="custom">自定义 SMTP</option></select></label><label><span>账户标签</span><input required value={label} onChange={(e) => setLabel(e.target.value)}/></label><label><span>显示名称</span><input required value={fromName} onChange={(e) => setFromName(e.target.value)}/></label><label><span>发件邮箱</span><input type="email" required value={fromEmail} onChange={(e) => setFromEmail(e.target.value)}/></label><label><span>Reply-To（可选）</span><input type="email" value={replyTo} onChange={(e) => setReplyTo(e.target.value)}/></label><label><span>每日上限</span><input type="number" min="1" max="500" value={dailyCap} onChange={(e) => setDailyCap(Number(e.target.value))}/></label>{provider === "custom" && <><label><span>SMTP Host</span><input required value={host} onChange={(e) => setHost(e.target.value)}/></label><label><span>端口</span><input required type="number" value={port} onChange={(e) => setPort(Number(e.target.value))}/></label></>}</div>
            {provider === "custom" ? <><label className="check-label"><input type="checkbox" checked={secure} onChange={(e) => setSecure(e.target.checked)}/>SMTP over TLS（465 通常开启；587 通常关闭后使用 STARTTLS）</label><label className="password-field"><span>应用密码 / SMTP Password</span><input type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="只写，不会回显"/></label><div className="secret-note">密码只保存在当前本地发送网关的内存中，重启后需要重新输入。</div></> : <div className="oauth-note"><b>无需填写邮箱密码</b><span>点击下方按钮后，在 {provider === "gmail" ? "Google" : "Microsoft"} 官方页面确认发信权限。授权令牌只保存在本地网关内存中。</span></div>}
            <button className="primary-button full" disabled={busy || !workspace.gateway?.online}>{busy ? "正在连接…" : provider === "custom" ? "保存 SMTP 配置（下一步测试）" : `连接 ${provider === "gmail" ? "Gmail" : "Outlook"} 并授权`}</button>
          </form>
        </article>
      </section>
      <section className="panel ai-config-panel">
        <div>
          <p className="eyebrow">AI PERSONALIZATION</p>
          <div className="section-title-row compact"><h2>AI 个性化配置</h2><Pill tone={workspace.gateway?.ai?.configured ? "green" : "amber"}>{workspace.gateway?.ai?.configured ? "当前会话已配置" : "需要配置"}</Pill></div>
          <p>模型只生成模板中的 <code>{"{{personalized_hook}}"}</code>，不会修改报价、交付要求、CTA 或签名。API Key 只保存在本地网关内存中，重启后需要重新输入。</p>
        </div>
        <form onSubmit={(event) => { event.preventDefault(); postSend({ action: "configure_ai", ai: { provider: "anthropic", model: aiModel, api_key: aiKey } }).then(() => setAiKey("")); }}>
          <label><span>模型</span><input required value={aiModel} onChange={(event) => setAiModel(event.target.value)} /></label>
          <label className="password-field"><span>Anthropic API Key</span><input type="password" autoComplete="new-password" required value={aiKey} onChange={(event) => setAiKey(event.target.value)} placeholder="只写，不会回显" /></label>
          <button className="primary-button" disabled={busy || !workspace.gateway?.online}>{busy ? "正在保存…" : "保存 AI 配置"}</button>
        </form>
      </section>
    </>
  );
}

function Replies() {
  return <><div className="page-heading"><div><p className="eyebrow">INBOX MONITOR</p><h1>回复与报价</h1><p className="lede">回复系统只会匹配已经发送并有稳定 Message-ID 的线程。</p></div><Pill tone="neutral">尚未连接 IMAP</Pill></div><section className="reply-kpis"><div><span>已匹配回复</span><strong>0</strong><small>等待真实线程</small></div><div><span>合作意向</span><strong>0</strong><small>尚无分类结果</small></div><div><span>报价入库</span><strong>0</strong><small>CRM 写入关闭</small></div><div><span>自动跟进</span><strong>0</strong><small>固定报价项目已禁用</small></div></section><Empty title="暂时没有真实回复" text="真实发送完成后，回复才能按 Message-ID 关联到项目和达人。" /></>;
}

function Safety({ workspace }: any) {
  const controls = [
    ["不可变审批批次", "From、To、Subject、Body 和项目发件分配使用 SHA-256 锁定"],
    ["批次单次入队", "浏览器只提交一次 run_id，双击和断网重试返回同一运行实例"],
    ["持久发送日志", "邮件服务商调用前先写 sending 并分配稳定 Message-ID"],
    ["全局运行锁", "所有项目共用一把发送锁，禁止并发消耗同一邮箱额度"],
    ["未知投递熔断", "网络结果不明确时立即暂停，绝不自动重试"],
    ["凭据只写", "OAuth 令牌和应用密码不进入项目数据库、不回显、不写审计日志"],
  ];
  return <><div className="page-heading"><div><p className="eyebrow">GUARDRAILS / AUDIT</p><h1>安全门禁与审计</h1><p className="lede">项目管理不会绕开首次建联 Agent 的幂等、额度、稳定 Message-ID、运行锁和全局熔断。</p></div><Pill tone={workspace.gateway?.circuit?.open ? "red" : "green"}>{workspace.gateway?.circuit?.open ? "全局熔断已打开" : "外发熔断器正常"}</Pill></div>{workspace.gateway?.circuit?.open && <section className="critical-banner"><b>禁止继续发送</b><p>{workspace.gateway.circuit.reason || "存在未解决的投递结果"}</p></section>}<section className="safety-grid">{controls.map(([title, text], index) => <article className="panel safety-card" key={title}><span className="safety-index">0{index + 1}</span><div><h2>{title}</h2><p>{text}</p></div><Pill tone="green">ACTIVE</Pill></article>)}</section><section className="panel audit-stream"><div className="section-title-row compact"><div><p className="eyebrow">AUDIT EVENTS</p><h2>最近项目事件</h2></div><code>D1 append-only view</code></div>{workspace.audit_events.map((event: any) => <div className="audit-row" key={event.id}><time>{new Date(event.created_at).toLocaleString("zh-CN", { hour12: false })}</time><span className="event-dot"></span><b>{event.event_type}</b><code>{event.entity_id}</code></div>)}</section></>;
}

export default function Home() {
  const [view, setView] = useState<View>("projects");
  const [workspace, setWorkspace] = useState<any>(null);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showRecipients, setShowRecipients] = useState(false);
  const [job, setJob] = useState<any>(null);

  async function load(projectId = selectedProjectId) {
    const payload = await readResponse(await fetch(`/api/send${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ""}`, { cache: "no-store" }));
    setWorkspace(payload);
    setSelectedProjectId(payload.selected_project_id || projectId || "");
    return payload;
  }

  useEffect(() => { load("").catch((error) => setNotice({ tone: "error", text: error.message })); }, []);

  const project = workspace?.projects?.find((item: any) => item.id === selectedProjectId) || workspace?.projects?.[0] || null;
  const latestBatch = workspace?.batches?.[0];
  useEffect(() => {
    if (!latestBatch?.job_id || !["queued", "sending"].includes(latestBatch.status)) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const payload = await readResponse(await fetch(`/api/send?project_id=${encodeURIComponent(project.id)}&batch_id=${encodeURIComponent(latestBatch.id)}&job_id=${encodeURIComponent(latestBatch.job_id)}`, { cache: "no-store" }));
        if (!cancelled) { setWorkspace(payload); setJob(payload.job); }
      } catch (error: any) {
        if (!cancelled) setNotice({ tone: "error", text: error.message });
      }
    };
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [latestBatch?.job_id, latestBatch?.status, project?.id]);

  async function perform(path: string, payload: any) {
    setBusy(true); setNotice(null);
    try {
      const result = await readResponse(await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }));
      setWorkspace(result);
      if (result.selected_project_id) setSelectedProjectId(result.selected_project_id);
      if (result.job) setJob(result.job);
      setNotice({ tone: "success", text: "操作已完成" });
      return result;
    } catch (error: any) {
      setNotice({ tone: "error", text: error.message });
      throw error;
    } finally { setBusy(false); }
  }

  async function postWorkspace(payload: any) {
    const result = await perform("/api/workspace", payload);
    if (payload.action === "create_project") { setShowCreate(false); setSelectedProjectId(result.project_id); }
    if (payload.action === "set_recipients") setShowRecipients(false);
    await load(result.project_id || payload.project_id || selectedProjectId);
    return result;
  }
  async function postSend(payload: any) {
    const result = await perform("/api/send", payload);
    await load(payload.project_id || project?.id || "");
    return result;
  }

  async function selectProject(id: string) {
    setSelectedProjectId(id); setJob(null); setBusy(true);
    try { await load(id); } catch (error: any) { setNotice({ tone: "error", text: error.message }); } finally { setBusy(false); }
  }

  if (!workspace) return <main className="loading-screen"><div className="brand-mark"><span></span><span></span><span></span></div><b>正在读取项目工作台…</b><small>本地 D1 与安全发送网关</small>{notice && <p>{notice.text}</p>}</main>;

  const content = view === "projects"
    ? <ProjectCenter workspace={workspace} project={project} busy={busy} postWorkspace={postWorkspace} selectProject={selectProject} openCreate={() => setShowCreate(true)} openRecipients={() => setShowRecipients(true)} openApprovals={() => setView("approvals")}/>
    : view === "approvals"
      ? <Approvals key={`${project?.id}-${latestBatch?.id || "none"}-${latestBatch?.status || "empty"}`} workspace={workspace} project={project} busy={busy} postWorkspace={postWorkspace} postSend={postSend} job={job}/>
      : view === "replies"
        ? <Replies />
        : view === "senders"
          ? <SenderAccounts workspace={workspace} busy={busy} postSend={postSend}/>
          : <Safety workspace={workspace}/>;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><span></span><span></span><span></span></div><div><b>LOOP</b><small>CREATOR OS</small></div></div>
        <div className="agent-card"><div className="agent-symbol">↗</div><div><small>当前 AGENT</small><b>首次建联</b></div><span className="online-dot"></span></div>
        <nav aria-label="主导航">{navItems.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}><span>{item.icon}</span>{item.label}{item.id === "approvals" && latestBatch && <em>{latestBatch.item_count}</em>}</button>)}</nav>
        <div className="sidebar-spacer"></div>
        <div className="sandbox-card"><Pill tone={workspace.gateway?.online ? "green" : "red"}>{workspace.gateway?.online ? "LOCAL GATEWAY" : "GATEWAY OFFLINE"}</Pill><p>{project?.name || "未选择项目"}</p><small>{workspace.gateway?.circuit?.open ? "外发已熔断" : "默认先审批，再正式入队"}</small></div>
        <div className="operator"><Avatar name="Vira" tone="blue"/><div><b>本地操作员</b><small>Project Manager</small></div><button aria-label="更多" disabled>•••</button></div>
      </aside>
      <section className="workspace">
        <header className="topbar"><div className="breadcrumb"><span>Projects</span><i>/</i><b>{project?.name || "项目中心"}</b></div><div className="topbar-right"><div className="test-chip"><span>✓</span>{workspace.projects.length} 个项目</div><div className="clock"><span className={`pulse small ${workspace.gateway?.online ? "" : "offline"}`}></span>{workspace.gateway?.online ? "发送网关在线" : "仅项目管理"}</div></div></header>
        {notice && <div className={`toast ${notice.tone}`}><span>{notice.text}</span><button onClick={() => setNotice(null)}>×</button></div>}
        <div className="page-content" key={`${view}-${project?.id || "none"}`}>{content}</div>
      </section>
      {showCreate && <CreateProjectModal workspace={workspace} close={() => setShowCreate(false)} submit={postWorkspace} busy={busy}/>}
      {showRecipients && project && <RecipientModal workspace={workspace} project={project} close={() => setShowRecipients(false)} submit={postWorkspace} busy={busy}/>}
    </main>
  );
}
