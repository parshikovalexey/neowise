import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));

const MAX_BODY_BYTES = 64 * 1024;
const MODEL_TIMEOUT_MS = 300;
const ALLOWED_TOPICS = new Set(["delivery", "pricing", "other"]);

class InvalidInputError extends Error {}

class ModelError extends Error {
  constructor(reason, message, options) {
    super(message, options);
    this.name = "ModelError";
    this.reason = reason;
  }
}

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new InvalidInputError("request body is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parsePayload(raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new InvalidInputError("request body is not valid JSON");
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new InvalidInputError("request body must be a JSON object");
  }
  return payload;
}

function readText(payload) {
  const { text } = payload;
  if (typeof text !== "string" || text.trim() === "") {
    throw new InvalidInputError("text must be a non-empty string");
  }
  return text;
}

function manualReview(response) {
  return json(response, 200, { status: "manual_review", topic: null, draft: null });
}

function logFailure(error, text) {
  const reason = error instanceof ModelError ? error.reason : "unexpected_error";
  const cause = error instanceof Error ? error.cause : undefined;
  const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : (error instanceof Error ? error.message : String(error));
  console.error(`[triage] ${new Date().toISOString()} failure reason=${reason} detail=${detail} text=${JSON.stringify(text)}`);
}

async function requestClassification(text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    return await classify(text, { signal: controller.signal });
  } catch (error) {
    const reason = controller.signal.aborted ? "timeout" : "provider_error";
    throw new ModelError(reason, "model call failed", { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

function parseModelOutput(raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw new ModelError("invalid_output", "model output is not valid JSON", { cause: error });
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ModelError("invalid_output", "model output must be a JSON object");
  }
  const { topic, draft } = payload;
  if (typeof topic !== "string" || !ALLOWED_TOPICS.has(topic)) {
    throw new ModelError("invalid_output", `unexpected topic: ${String(topic)}`);
  }
  if (typeof draft !== "string" || draft.trim() === "") {
    throw new ModelError("invalid_output", "model draft must be a non-empty string");
  }
  return { topic, draft };
}

async function handleTriage(request, response) {
  const text = readText(parsePayload(await readBody(request)));
  let result;
  try {
    result = parseModelOutput(await requestClassification(text));
  } catch (error) {
    logFailure(error, text);
    return manualReview(response);
  }
  return json(response, 200, { status: "ready", topic: result.topic, draft: result.draft });
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
  } catch (error) {
    if (error instanceof InvalidInputError) {
      return json(response, 400, { status: "invalid_input" });
    }
    console.error(`[triage] ${new Date().toISOString()} failure reason=unexpected_error detail=${error instanceof Error ? error.message : String(error)}`);
    json(response, 500, { status: "server_error" });
  }
}).listen(Number(process.env.PORT || 3000), "127.0.0.1");
