import test from "node:test";
import assert from "node:assert/strict";
import { extractJsonFromText, parseProviderJson } from "../src/lib/anonymizer.js";
import { anonymizeWithLmStudio } from "../src/lib/providers/lmstudio.js";
import { anonymizeWithOllama } from "../src/lib/providers/ollama.js";

test("extractJsonFromText accepts fenced JSON", () => {
  assert.equal(
    extractJsonFromText("```json\n{\"fields\":{\"name\":\"name\"}}\n```"),
    "{\"fields\":{\"name\":\"name\"}}"
  );
});

test("parseProviderJson extracts embedded object JSON", () => {
  const parsed = parseProviderJson("prefix ```json\n{\"fields\":{\"conto\":\"none\"}}\n``` suffix");
  assert.deepEqual(parsed, {
    fields: {
      conto: "none"
    }
  });
});

test("LM Studio adapter extracts message content", async () => {
  const text = await anonymizeWithLmStudio({
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "gemma",
    systemPrompt: "sys",
    userPrompt: "user",
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: "```json\n{\"fields\":{\"name\":\"name\"}}\n```"
              }
            }
          ]
        };
      }
    })
  });

  assert.match(text, /fields/);
});

test("Ollama adapter extracts message content", async () => {
  const text = await anonymizeWithOllama({
    baseUrl: "http://127.0.0.1:11434",
    model: "gemma3:4b",
    systemPrompt: "sys",
    userPrompt: "user",
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          message: {
            content: "{\"fields\":{\"conto\":\"none\"}}"
          }
        };
      }
    })
  });

  assert.match(text, /fields/);
});

function abortableFetch({ hangBody = false } = {}) {
  return (_url, { signal }) => {
    const waitForAbort = () =>
      new Promise((_resolve, reject) => {
        const guard = setTimeout(() => reject(new Error("request was never aborted")), 300);
        signal.addEventListener("abort", () => {
          clearTimeout(guard);
          reject(signal.reason);
        });
      });
    if (!hangBody) return waitForAbort();
    return Promise.resolve({ ok: true, json: waitForAbort });
  };
}

const CALL = { baseUrl: "http://127.0.0.1:1", model: "m", systemPrompt: "s", userPrompt: "u", timeoutMs: 20 };

test("provider timeouts abort with a recognizable AbortError and a clear message", async () => {
  await assert.rejects(
    anonymizeWithLmStudio({ ...CALL, fetchImpl: abortableFetch() }),
    /LM Studio provider request timed out after 20ms/
  );
  await assert.rejects(
    anonymizeWithOllama({ ...CALL, fetchImpl: abortableFetch() }),
    /Ollama provider request timed out after 20ms/
  );
});

test("provider timeouts also cover a stalled response body", async () => {
  await assert.rejects(
    anonymizeWithLmStudio({ ...CALL, fetchImpl: abortableFetch({ hangBody: true }) }),
    /timed out after 20ms/
  );
  await assert.rejects(
    anonymizeWithOllama({ ...CALL, fetchImpl: abortableFetch({ hangBody: true }) }),
    /timed out after 20ms/
  );
});

test("provider adapters report HTTP status, empty content and network failures", async () => {
  await assert.rejects(
    anonymizeWithOllama({ ...CALL, fetchImpl: async () => ({ ok: false, status: 503 }) }),
    /^Error: Ollama provider request failed with status 503\.$/
  );
  await assert.rejects(
    anonymizeWithLmStudio({ ...CALL, fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [] }) }) }),
    /LM Studio provider returned no message content/
  );
  await assert.rejects(
    anonymizeWithLmStudio({ ...CALL, fetchImpl: async () => { throw new TypeError("fetch failed"); } }),
    /LM Studio provider request failed: fetch failed/
  );
});

test("provider adapters send the expected request bodies", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ choices: [{ message: { content: "{}" } }], message: { content: "{}" } }) };
  };
  await anonymizeWithLmStudio({ ...CALL, baseUrl: "http://127.0.0.1:1234/v1", fetchImpl });
  await anonymizeWithOllama({ ...CALL, baseUrl: "http://127.0.0.1:11434", fetchImpl });

  assert.equal(seen[0].url, "http://127.0.0.1:1234/v1/chat/completions");
  assert.deepEqual(seen[0].body.response_format, { type: "json_object" });
  assert.equal(seen[1].url, "http://127.0.0.1:11434/api/chat");
  assert.equal(seen[1].body.stream, false);
  assert.equal(seen[1].body.format, "json");
});
