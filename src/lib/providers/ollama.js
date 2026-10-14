import { requestProviderChat } from "./http-client.js";

export const ollamaAdapter = {
  label: "Ollama",
  path: "api/chat",
  buildBody({ model, systemPrompt, userPrompt }) {
    return {
      model,
      stream: false,
      format: "json",
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: userPrompt
        }
      ]
    };
  },
  extractText(payload) {
    return payload?.message?.content;
  }
};

export function anonymizeWithOllama(options) {
  return requestProviderChat({ ...options, adapter: ollamaAdapter });
}
