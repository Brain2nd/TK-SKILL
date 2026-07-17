export function itemPayloadSnapshot(item) {
  return {
    project_id: String(item.project_id || ""),
    creator_id: String(item.creator_id || ""),
    candidate_id: String(item.candidate_id || ""),
    handle: String(item.handle || ""),
    recipient_email: String(item.recipient_email || ""),
    sender_id: String(item.sender_id || ""),
    from_name: String(item.from_name || ""),
    from_email: String(item.from_email || ""),
    reply_to_email: String(item.reply_to_email || ""),
    subject: String(item.subject || ""),
    body: String(item.body || ""),
    idempotency_key: String(item.idempotency_key || ""),
  };
}

export function canonicalItemPayload(item) {
  return JSON.stringify(itemPayloadSnapshot(item));
}

export function canonicalBatchSnapshot({ batch_id, project_id, campaign_id, items }) {
  return JSON.stringify({
    batch_id: String(batch_id || ""),
    project_id: String(project_id || ""),
    campaign_id: String(campaign_id || ""),
    items: (Array.isArray(items) ? items : []).map((item) => ({
      id: String(item.id || ""),
      payload_hash: String(item.payload_hash || ""),
    })),
  });
}
