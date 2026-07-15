/**
 * deadline-engine — 阶段感知的 deadline + nudge 调度规则
 *
 * 每阶段规则按 SOP V5 编码：
 *   - anchor: 哪个时间字段是该阶段 deadline 的起点（stage_entered / qc_pass / package_delivered / unboxing_live / teaser_live）
 *   - red_line_days: 硬线（超过则 escalate / stop_shipping / drop）
 *   - nudges: 软线列表（[{at_days, action, reason}]）—— at_days 从 anchor 起算
 *   - terminal: true 表示该阶段不再产出 deadline（XX_Dropped / 09_Completed）
 *
 * nudgesDue(creator, now) 返回 null（无事可做）或 { action, days_overdue, template_step, reason }
 *   - action: nudge | escalate | stop_shipping | drop
 *   - template_step: 建议用哪一步的模板回信（agent / cron 据此生成催促邮件）
 *
 * deadlineFor(stage, anchorMs) 返回 { red_line_at, nudge_ats: [...] } 用于写入 deadlines 表
 */

const DAY = 86400 * 1000;

export const RULES = {
  "00_Discovered": {
    anchor: "stage_entered",
    note: "无 deadline，auto_outreach cron 会推到 01",
  },
  "01_FirstOutreach": {
    anchor: "stage_entered",
    nudges: [
      { at_days: 7,  action: "nudge",   template_step: "step01_followup", reason: "首次开发信 7 天无回复，发一次 follow-up" },
    ],
    red_line_days: 14,
    red_line_action: "drop",
    red_line_reason: "首次开发信 14 天仍无回应，标记 XX_Dropped",
  },
  "02_CollabOffer": {
    anchor: "stage_entered",
    nudges: [
      { at_days: 3, action: "nudge", template_step: "step02_followup", reason: "报价 3 天无回复，催一次确认" },
    ],
    red_line_days: 7,
    red_line_action: "drop",
    red_line_reason: "报价 7 天仍无回应，XX_Dropped",
  },
  "03_Agreed": {
    anchor: "stage_entered",
    nudges: [
      { at_days: 7, action: "nudge", template_step: "step03_check_bio", reason: "同意合作但未确认 bio/linktree 已挂联盟链接" },
    ],
    red_line_days: 14,
    red_line_action: "drop",
    red_line_reason: "同意合作 14 天仍未挂链接，XX_Dropped",
  },
  "04_ContractSigned": {
    anchor: "stage_entered",
    note: "签约后等 QC 通过 → agent 推 05；本阶段不主动催",
  },
  "05_TeaserDraftDue": {
    anchor: "qc_pass",
    nudges: [
      { at_days: 3, action: "nudge", template_step: "step05", reason: "QC 通过 3 天未交预热视频草稿，第一次催" },
    ],
    red_line_days: 5,
    red_line_action: "stop_shipping",
    red_line_reason: "QC 通过 5 天仍无草稿——暂停发货，运营人工评估是否继续合作（SOP 红线）",
  },
  "06_PackageShipped": {
    anchor: "stage_entered",
    note: "包裹运输中（≈15 天），无主动催；agent 监测物流状态变化推到 07",
  },
  "07_PackageDelivered": {
    anchor: "package_delivered",
    nudges: [
      { at_days: 3, action: "nudge", template_step: "step07_followup_3d", reason: "送达 3 天未交开箱视频草稿，第一次催" },
      { at_days: 5, action: "nudge", template_step: "step07_followup_5d", reason: "送达 5 天仍无草稿，第二次催（agent 自起草）" },
    ],
    red_line_days: 7,
    red_line_action: "escalate",
    red_line_reason: "送达 7 天为开箱视频 deadline，超期 → 升级人工评估",
  },
  "08_TryOnVideo": {
    anchor: "unboxing_live",
    nudges: [
      { at_days: 5, action: "nudge", template_step: "step08_followup", reason: "开箱发布 5 天未发 Try-On & Q&A 视频，催一次" },
    ],
    red_line_days: 10,
    red_line_action: "escalate",
    red_line_reason: "开箱发布 10 天仍无 Try-On 视频（合同约定上限）→ 升级人工评估",
  },
  "09_Completed": { terminal: true },
  "XX_Dropped":   { terminal: true },
};

const ANCHOR_FIELD = {
  stage_entered: "Stage Entered At",
  qc_pass: "QC Pass Date",
  package_delivered: "Package Delivered Date",
  unboxing_live: "Unboxing Live At",
  teaser_live: "Teaser Live At",
};

function getAnchorMs(creatorFields, anchorKey) {
  const fname = ANCHOR_FIELD[anchorKey];
  if (!fname) return null;
  const v = creatorFields[fname];
  if (!v) return null;
  return typeof v === "number" ? v : null;
}

/**
 * 给一个阶段 + anchor 时间戳，算出 red line 和所有 nudge 的绝对时间点。
 * 用来写入 deadlines 表当缓存。
 */
export function deadlineFor(stage, anchorMs) {
  const rule = RULES[stage];
  if (!rule || rule.terminal) return null;
  if (anchorMs == null) return { error: `stage ${stage} anchor (${rule.anchor}) 未填，需要运营手填或上游补 webhook` };
  const out = {
    stage,
    anchor: rule.anchor,
    anchor_at: anchorMs,
    nudge_ats: (rule.nudges || []).map(n => ({
      at: anchorMs + n.at_days * DAY,
      at_days: n.at_days,
      action: n.action,
      template_step: n.template_step,
      reason: n.reason,
    })),
  };
  if (rule.red_line_days != null) {
    out.red_line_at = anchorMs + rule.red_line_days * DAY;
    out.red_line_action = rule.red_line_action;
    out.red_line_reason = rule.red_line_reason;
  }
  return out;
}

/**
 * 判断 creator 现在是否应该被催 / 升级 / 丢弃。
 * @param {object} creatorFields  Bitable creators 行的 fields（含 Pipeline Stage / Stage Entered At / QC Pass Date 等）
 * @param {number} [now=Date.now()]
 * @returns {null|object}
 *   null = 当前无事；
 *   { action, days_overdue, template_step, reason, anchor, anchor_at, missing_anchor? } = 需采取动作
 */
export function nudgesDue(creatorFields, now = Date.now()) {
  const stage = creatorFields["Pipeline Stage"];
  const rule = RULES[stage];
  if (!rule || rule.terminal || rule.note && !rule.nudges && !rule.red_line_days) return null;

  const anchorMs = getAnchorMs(creatorFields, rule.anchor);
  if (anchorMs == null) {
    return {
      action: "missing_anchor",
      anchor: rule.anchor,
      reason: `阶段 ${stage} 需要 anchor 字段 "${ANCHOR_FIELD[rule.anchor]}" 但未填——请运营在 Bitable 手填或等待上游 webhook`,
    };
  }

  // Red line 优先（一旦超红线立刻处理，不再考虑 nudges）
  if (rule.red_line_days != null) {
    const redLineAt = anchorMs + rule.red_line_days * DAY;
    if (now >= redLineAt) {
      return {
        action: rule.red_line_action,
        days_overdue: Math.floor((now - redLineAt) / DAY),
        anchor: rule.anchor,
        anchor_at: anchorMs,
        red_line_at: redLineAt,
        reason: rule.red_line_reason,
      };
    }
  }

  // 找最早一个还没过 / 刚过的 nudge
  for (const n of (rule.nudges || [])) {
    const nudgeAt = anchorMs + n.at_days * DAY;
    if (now >= nudgeAt) {
      // 检查是否已经发过（caller 用 email_log 反查 template_id 是否已经发送），这里只判断"该发"
      return {
        action: n.action,
        template_step: n.template_step,
        days_overdue: Math.floor((now - nudgeAt) / DAY),
        anchor: rule.anchor,
        anchor_at: anchorMs,
        nudge_at: nudgeAt,
        reason: n.reason,
      };
    }
  }
  return null; // 还没到任何 nudge / red line
}

/**
 * 一次性扫一组 creators（auto_reply_monitor 调用），返回需要采取动作的列表。
 * @param {Array<{record_id, fields}>} creators
 * @returns {Array<{handle, record_id, ...nudge_result}>}
 */
export function nudgesForBatch(creators, now = Date.now()) {
  const out = [];
  for (const c of creators) {
    const r = nudgesDue(c.fields, now);
    if (!r) continue;
    out.push({
      handle: c.fields["username"],
      record_id: c.record_id,
      stage: c.fields["Pipeline Stage"],
      ...r,
    });
  }
  return out;
}
