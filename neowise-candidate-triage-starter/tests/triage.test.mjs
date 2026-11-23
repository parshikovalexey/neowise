import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, test } from "node:test";

const PORT = 3987;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };
const READY_KEYS = ["status", "topic", "draft"];

let server;
let serverOutput = "";

async function isReady() {
  try {
    await fetch(`${BASE_URL}/`);
    return true;
  } catch {
    return false;
  }
}

before(async () => {
  server = spawn(process.execPath, ["server.mjs"], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk;
    // Логи сервера (включая причины сбоев и текст заявки) печатаем в консоль прогона.
    process.stderr.write(chunk);
  });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await isReady()) return;
    if (server.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not start: ${serverOutput}`);
});

after(() => {
  server?.kill();
});

function post(body) {
  return fetch(`${BASE_URL}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function expectManualReview(text) {
  const startedAt = Date.now();
  const response = await post({ text });
  const elapsed = Date.now() - startedAt;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), MANUAL_REVIEW);
  return elapsed;
}

async function waitForLog(fragment) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (serverOutput.includes(fragment)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`в логе сервера нет "${fragment}". Лог сервера:\n${serverOutput}`);
}

test("страница отдаётся и содержит форму разбора", async () => {
  const response = await fetch(`${BASE_URL}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  const page = await response.text();
  assert.match(page, /Разобрать заявку/);
  assert.match(page, /id="status"/);
});

test("модель не ответила за 300 мс — заявка уходит на ручной разбор", async () => {
  const elapsed = await expectManualReview("[timeout]");
  // Имитатор отвечает через 1200 мс; ответ должен прийти примерно за 300 мс.
  assert.ok(elapsed < 900, `ответ занял ${elapsed} мс, ограничение ожидания модели — 300 мс`);
});

test("ошибка модели превращается в ручной разбор, а не в 500", async () => {
  await expectManualReview("[error]");
});

test("ответ модели не JSON — ручной разбор", async () => {
  await expectManualReview("[bad-json]");
});

test("недопустимая тема — ручной разбор", async () => {
  await expectManualReview("[bad-topic]");
});

test("пустой черновик — ручной разбор", async () => {
  await expectManualReview("[empty-draft]");
});

test("сбой модели пишется в лог вместе с текстом заявки", async () => {
  const text = "[error] клиент не может войти в личный кабинет";
  await expectManualReview(text);
  await waitForLog("reason=provider_error");
  await waitForLog(JSON.stringify(text));
});

test("сбой из-за таймаута помечен в логе как timeout", async () => {
  await expectManualReview("[timeout]");
  await waitForLog("reason=timeout");
});

test("неподходящий ответ модели помечен в логе как invalid_output", async () => {
  await expectManualReview("[bad-topic]");
  await waitForLog("reason=invalid_output");
});

test("пустой, отсутствующий и нестроковый текст — 400 invalid_input", async () => {
  for (const payload of [{ text: "" }, { text: "   " }, { text: null }, { text: 42 }, { text: ["a"] }, {}]) {
    const response = await post(payload);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { status: "invalid_input" });
  }
});

test("тело не JSON-объект — 400 invalid_input", async () => {
  for (const body of ["{oops", "", "null", "[]", '"text"', "42"]) {
    const response = await post(body);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { status: "invalid_input" });
  }
});

test("тело больше 64 КБ — 400 invalid_input", async () => {
  const response = await post({ text: "а".repeat(70 * 1024) }).catch((error) => error);
  if (response instanceof Error) {
    assert.fail(`большое тело не должно ломать запрос: ${response.message}`);
  }
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { status: "invalid_input" });
});

test("неизвестные маршруты и методы — 404", async () => {
  for (const [method, path] of [["GET", "/api/triage"], ["POST", "/api/other"], ["PUT", "/api/triage"]]) {
    const response = await fetch(`${BASE_URL}${path}`, { method });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { status: "not_found" });
  }
});

test("корректная заявка — готовая тема и черновик", async () => {
  const response = await post({ text: "Доставка задерживается, клиент ждёт" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body), READY_KEYS);
  assert.equal(body.status, "ready");
  assert.equal(body.topic, "delivery");
  assert.equal(typeof body.draft, "string");
  assert.ok(body.draft.trim().length > 0);
});

test("темы delivery, pricing и other распознаются", async () => {
  const cases = [
    ["Доставка задерживается", "delivery"],
    ["Какая стоимость доставки", "pricing"],
    ["Хочу оставить отзыв о сервисе", "other"],
  ];
  for (const [text, topic] of cases) {
    const response = await post({ text });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "ready",
      topic,
      draft: "Спасибо за обращение. Уточним детали заявки.",
    });
  }
});
