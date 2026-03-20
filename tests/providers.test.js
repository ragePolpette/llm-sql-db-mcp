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
