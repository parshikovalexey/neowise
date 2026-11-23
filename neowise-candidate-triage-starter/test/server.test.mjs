import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createAppServer } from "../server.mjs";

const server = createAppServer();
let baseUrl;

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

async function postTriage(body) {
  return fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

async function captureErrors(action) {
  const originalError = console.error;
  const entries = [];
  console.error = (...args) => {
    entries.push(args.map((item) => item instanceof Error ? `${item.name}: ${item.message}` : String(item)).join(" "));
  };

  try {
    const result = await action();
    return { result, output: entries.join("\n") };
  } finally {
    console.error = originalError;
  }
}

test("GET / serves the page and unknown routes return 404", async () => {
  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  const pageHtml = await page.text();
  assert.ok(pageHtml.includes('result.textContent = "";'));
  assert.ok(pageHtml.includes(".result-success { color: #166534"));
  assert.ok(pageHtml.includes(".result-error { color: #991b1b"));
  assert.ok(pageHtml.includes("Тема: ${body.topic}\\nЧерновик ответа:\\n${body.draft}"));
  assert.ok(pageHtml.includes('showResult("Не удалось автоматически обработать заявку. Разберите заявку вручную и ответьте клиенту сами.", "error")'));

  const missingRoute = await fetch(`${baseUrl}/missing`);
  assert.equal(missingRoute.status, 404);
  assert.deepEqual(await missingRoute.json(), { status: "not_found" });
});

test("valid requests return each allowed topic and a nonempty draft", async () => {
  const examples = [
    ["доставка задерживается", "delivery"],
    ["уточните цену", "pricing"],
    ["у меня вопрос", "other"],
  ];

  for (const [text, topic] of examples) {
    const response = await postTriage(JSON.stringify({ text }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "ready");
    assert.equal(body.topic, topic);
    assert.equal(typeof body.draft, "string");
    assert.notEqual(body.draft.trim(), "");
  }
});

test("malformed JSON, missing, non-string, and empty text return invalid_input", async () => {
  const cases = [
    ["malformed JSON", "{"],
    ["missing text", JSON.stringify({})],
    ["non-string text", JSON.stringify({ text: 42 })],
    ["empty text", JSON.stringify({ text: "  \n " })],
  ];

  for (const [name, body] of cases) {
    const { result, output } = await captureErrors(async () => {
      const response = await postTriage(body);
      return { response, payload: await response.json() };
    });
    assert.equal(result.response.status, 400, name);
    assert.deepEqual(result.payload, { status: "invalid_input" }, name);
    if (name === "malformed JSON") assert.match(output, /Invalid triage request JSON/);
  }
});

test("AI failures return manual_review, clear the draft, and log the cause", async (t) => {
  const scenarios = [
    ["provider error", "[error]", /Mock provider unavailable/],
    ["malformed AI JSON", "[bad-json]", /SyntaxError/],
    ["unsupported topic", "[bad-topic]", /unsupported topic/],
    ["empty draft", "[empty-draft]", /empty or invalid draft/],
    ["timeout", "[timeout]", /timed out/],
  ];

  for (const [name, text, causePattern] of scenarios) {
    await t.test(name, async () => {
      const { result, output } = await captureErrors(async () => {
        const startedAt = performance.now();
        const response = await postTriage(JSON.stringify({ text }));
        return { response, payload: await response.json(), elapsedMs: performance.now() - startedAt };
      });

      assert.equal(result.response.status, 200);
      assert.deepEqual(result.payload, {
        status: "manual_review",
        topic: null,
        draft: null,
      });
      assert.match(output, /AI triage failed; manual review required/);
      assert.match(output, causePattern);
      if (name === "timeout") assert.ok(result.elapsedMs < 900, `timeout took ${result.elapsedMs} ms`);
    });
  }
});
