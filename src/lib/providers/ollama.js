function buildUrl(baseUrl, path) {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

export async function anonymizeWithOllama({
  baseUrl,
  model,
  systemPrompt,
  userPrompt,
  fetchImpl,
  timeoutMs
}) {
  const controller = typeof AbortController === "function" && timeoutMs ? new AbortController() : null;
  const timeout = controller
    ? setTimeout(() => controller.abort("timeout"), timeoutMs)
    : null;

  let response;
  try {
    response = await fetchImpl(buildUrl(baseUrl, "api/chat"), {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
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
      }),
      signal: controller?.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Ollama provider request timed out after ${timeoutMs}ms.`);
    }
    throw new Error(`Ollama provider request failed: ${error.message}`);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }

  if (!response.ok) {
    throw new Error(`Ollama provider request failed with status ${response.status}.`);
  }

  const payload = await response.json();
  const text = payload?.message?.content;

  if (typeof text !== "string" || text.trim() === "") {
    throw new Error("Ollama provider returned no message content.");
  }

  return text;
}
