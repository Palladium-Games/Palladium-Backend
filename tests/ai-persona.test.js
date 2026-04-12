const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const BACKEND_DIR = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(BACKEND_DIR, "apps.js"), "utf8");

function extractFunctionSource(name) {
  const signature = `function ${name}(`;
  const start = source.indexOf(signature);
  if (start === -1) {
    throw new Error(`Could not find function ${name}`);
  }

  let braceIndex = source.indexOf("{", start);
  let depth = 0;
  let end = braceIndex;
  for (; end < source.length; end += 1) {
    const char = source[end];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }

  return source.slice(start, end);
}

function loadAiHelpers() {
  const context = {};
  const script = [
    extractFunctionSource("normalizeAiPayload"),
    extractFunctionSource("buildAntarcticAiSystemPrompt"),
    extractFunctionSource("injectAntarcticAiSystemPrompt"),
    extractFunctionSource("flattenContent"),
    extractFunctionSource("buildPromptFromMessages"),
    extractFunctionSource("buildGeneratePayload"),
    "this.normalizeAiPayload = normalizeAiPayload;",
    "this.buildGeneratePayload = buildGeneratePayload;"
  ].join("\n\n");

  vm.runInNewContext(script, context, { filename: "backend-ai-helpers.js" });
  return context;
}

test("normalizeAiPayload prepends the Antarctic AI identity prompt", () => {
  const { normalizeAiPayload } = loadAiHelpers();

  const normalized = normalizeAiPayload(
    {
      messages: [{ role: "user", content: "who are you?" }]
    },
    "qwen3.5:0.8b"
  );

  assert.equal(normalized.messages[0].role, "system");
  assert.match(normalized.messages[0].content, /You are Antarctic AI/);
  assert.match(normalized.messages[0].content, /Do not introduce yourself as Qwen, Tongyi Lab/);
  assert.equal(normalized.messages[1].role, "user");
  assert.equal(normalized.messages[1].content, "who are you?");
});

test("normalizeAiPayload preserves existing system instructions behind the Antarctic AI prompt", () => {
  const { normalizeAiPayload, buildGeneratePayload } = loadAiHelpers();

  const normalized = normalizeAiPayload(
    {
      messages: [
        { role: "system", content: "Always answer in Markdown." },
        { role: "user", content: "who are you?" }
      ]
    },
    "qwen3.5:0.8b"
  );

  assert.equal(normalized.messages[0].role, "system");
  assert.match(normalized.messages[0].content, /You are Antarctic AI/);
  assert.match(normalized.messages[0].content, /Always answer in Markdown\./);

  const generatePayload = buildGeneratePayload(normalized, "qwen3.5:0.8b");
  assert.match(generatePayload.prompt, /System: You are Antarctic AI/);
  assert.match(generatePayload.prompt, /System: .*Always answer in Markdown\./s);
});
