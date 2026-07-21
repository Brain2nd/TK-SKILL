import assert from "node:assert/strict";
import test from "node:test";

import { personalizeHook } from "../lib/claude_personalizer.mjs";

test("personalizeHook accepts a write-only runtime key and returns only an evidence-bound hook", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (_url, options) => {
    captured = options;
    return {
      ok: true,
      async json() {
        return { content: [{ text: JSON.stringify({
          hook: "Your home styling content feels especially relevant to this opportunity.",
          evidence_ids: ["bio"],
        }) }] };
      },
    };
  };
  try {
    const result = await personalizeHook({
      api_key: "test-write-only-anthropic-key-123456",
      model: "claude-test-model",
      base_hook: "Your home content looks relevant to this opportunity.",
      creator_context: { handle: "creator", bio: "Home styling and decoration creator" },
      template_context: {
        subject: "Paid short-form opportunity",
        body: "Hi!\n\n{{personalized_hook}}\n\nThe protected offer stays here.\n\n{{sender_name}}",
        brand_name: "Test Brand",
      },
    });
    assert.equal(result.hook, "Your home styling content feels especially relevant to this opportunity.");
    assert.deepEqual(result.evidence_ids, ["bio"]);
    assert.equal(captured.headers["x-api-key"], "test-write-only-anthropic-key-123456");
    const body = JSON.parse(captured.body);
    assert.equal(body.model, "claude-test-model");
    assert.match(body.messages[0].content, /The protected offer stays here/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("personalizeHook falls back deterministically when no runtime key is configured", async () => {
  const result = await personalizeHook({
    api_key: "",
    base_hook: "Your UGC profile looks relevant to this opportunity.",
    creator_context: { handle: "creator", bio: "UGC creator" },
  });
  assert.equal(result.hook, "Your UGC profile looks relevant to this opportunity.");
  assert.match(result.fallback_reason, /API key/i);
});
