import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));
const AI_TIMEOUT_MS = 300;
const ALLOWED_TOPICS = Object.freeze(["delivery", "pricing", "other"]);

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function manualReview(response) {
  return json(response, 200, { status: "manual_review", topic: null, draft: null });
}

async function classifyWithTimeout(text, timeoutMs = AI_TIMEOUT_MS) {
  const controller = new AbortController();
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error("AI request timed out"));
    }, timeoutMs);
  });

  try {
    return await Promise.race([classify(text, { signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function handleTriage(request, response) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return json(response, 400, { status: "invalid_input" });
  }

  const { text } = payload ?? {};
  if (typeof text !== "string" || text.trim().length === 0) {
    return json(response, 400, { status: "invalid_input" });
  }

  return processText(text, response);
}

async function processText(text, response) {
  try {
    const result = JSON.parse(await classifyWithTimeout(text));
    if (
      result === null ||
      typeof result !== "object" ||
      !ALLOWED_TOPICS.includes(result.topic) ||
      typeof result.draft !== "string" ||
      result.draft.trim().length === 0
    ) {
      return manualReview(response);
    }

    return json(response, 200, {
      status: "ready",
      topic: result.topic,
      draft: result.draft,
    });
  } catch {
    return manualReview(response);
  }
}

createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
    return;
  }
  if (request.method !== "POST" || request.url !== "/api/triage") {
    return json(response, 404, { status: "not_found" });
  }
  try {
    await handleTriage(request, response);
  } catch {
    json(response, 500, { status: "server_error" });
  }
}).listen(Number(process.env.PORT || 3000), "127.0.0.1");
