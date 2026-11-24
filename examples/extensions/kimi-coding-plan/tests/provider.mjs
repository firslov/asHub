import { test } from "node:test";
import assert from "node:assert/strict";
import { catalog, prepare, registration } from "../provider.mjs";
export const raw = {
  data: [
    {
      id: "k3",
      limit: { context: 1048576 },
      modalities: { input: ["text", "image"] },
      reasoning: {
        type: "only",
        effort: { valid: ["low", "high", "max"], default: "high" },
      },
    },
    { id: "fast", limit: { context: 262144 }, reasoning: { type: "only" } },
  ],
};
test("catalog uses actual model capabilities and ignores invalid entries", () => {
  const m = catalog({
    data: [
      ...raw.data,
      raw.data[0],
      { id: "bad" },
      { id: "wrong", limit: { context: 100 }, protocol: "anthropic" },
    ],
  });
  assert.equal(m.length, 2);
  assert.equal(m[0].contextWindow, 1048576);
  assert.deepEqual(m[0].efforts, ["low", "high", "max"]);
  assert.equal(m[1].efforts.length, 0);
  assert.equal(registration(m)[0].echoReasoning, true);
  assert.throws(() => catalog({ data: [] }));
});
test("request preserves tools, images and reasoning history; maps effort and output limit", () => {
  const messages = [
    {
      role: "assistant",
      content: null,
      reasoning_content: "reason",
      tool_calls: [{ id: "call1" }],
    },
    { role: "tool", tool_call_id: "call1", content: "ok" },
    {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
      ],
    },
  ];
  const body = {
    model: "k3",
    messages,
    tools: [{ type: "function" }],
    max_tokens: 99999,
    reasoning_effort: "ultra",
    stream: true,
  };
  const result = prepare(body, catalog(raw), "low");
  assert.equal(result.messages, messages);
  assert.equal(result.tools, body.tools);
  assert.equal(result.max_completion_tokens, 32768);
  assert.equal(result.max_tokens, undefined);
  assert.equal(result.reasoning_effort, undefined);
  assert.deepEqual(result.thinking, { type: "enabled", effort: "low" });
  assert.equal(body.reasoning_effort, "ultra");
  assert.equal(prepare(body, catalog(raw)).thinking, undefined);
});
test("switching from Codex strips foreign reasoning metadata without dropping Kimi history or attachments", () => {
  const toolCalls = [{ id: "call1", type: "function", function: { name: "lookup", arguments: "{}" } }];
  const details = [{ type: "reasoning.encrypted", format: "openai-responses-v1", data: "A".repeat(2100000) }];
  const toolResult = { role: "tool", tool_call_id: "call1", content: "ok" };
  const user = { role: "user", content: [
    { type: "text", text: "Describe the image" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
  ] };
  const messages = [
    { role: "user", content: "Look it up" },
    { role: "assistant", content: null, tool_calls: toolCalls, reasoning_content: "native", reasoning: "alias", reasoning_details: details },
    toolResult,
    { role: "assistant", content: "Done", reasoning: "history from an older adapter" },
    user,
  ];
  assert(Buffer.byteLength(JSON.stringify(messages)) > 2 * 1024 * 1024);
  const result = prepare({ model: "k3", messages }, catalog(raw));
  assert.equal(Object.hasOwn(result.messages[1], "reasoning_details"), false);
  assert.deepEqual(result.messages, [
    messages[0],
    { role: "assistant", content: null, tool_calls: toolCalls, reasoning_content: "native" },
    toolResult,
    { role: "assistant", content: "Done", reasoning_content: "history from an older adapter" },
    user,
  ]);
  assert(Buffer.byteLength(JSON.stringify(result.messages)) < 2 * 1024 * 1024);
  assert.equal(messages[1].reasoning_details, details, "the live and stored transcript must remain untouched");
  assert.equal(result.messages[2], toolResult);
  assert.equal(result.messages[4], user);
});
test("unsupported effort is rejected per model instead of silently fabricating a level", () => {
  for (const [model, effort] of [
    ["fast", "low"],
    ["k3", "off"],
    ["k3", "medium"],
    ["missing", "default"],
  ])
    assert.throws(() => prepare({ model, messages: [] }, catalog(raw), effort));
  assert.throws(() =>
    prepare({ model: "k3", messages: [], max_tokens: -1 }, catalog(raw)),
  );
  const both = catalog({
    data: [{ ...raw.data[0], reasoning: { type: "both" } }],
  });
  assert.deepEqual(
    prepare({ model: "k3", messages: [] }, both, "off").thinking,
    { type: "disabled" },
  );
});
test("catalog accepts the documented flat capability fields", () => {
  const m = catalog({
    data: [
      {
        id: "legacy",
        context_length: 262144,
        supports_thinking_type: "only",
        think_efforts: { valid_efforts: ["low", "high"] },
      },
    ],
  });
  assert.equal(m[0].contextWindow, 262144);
  assert.equal(m[0].reasoning, true);
  assert.deepEqual(m[0].efforts, ["low", "high"]);
});
