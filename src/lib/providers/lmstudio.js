import { requestProviderChat } from "./http-client.js";

export const lmStudioAdapter = {
  label: "LM Studio",
  path: "chat/completions",
  buildBody({ model, systemPrompt, userPrompt }) {
    return {
      model,
      temperature: 0,
      response_format: {
        type: "json_object"
      },
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
    return payload?.choices?.[0]?.message?.content;
  }
};

export function anonymizeWithLmStudio(options) {
  return requestProviderChat({ ...options, adapter: lmStudioAdapter });
}
