function buildUrl(baseUrl, path) {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

export async function anonymizeWithLmStudio({
  baseUrl,
  model,
  systemPrompt,
  userPrompt,
  fetchImpl
}) {
  let response;
  try {
    response = await fetchImpl(buildUrl(baseUrl, "chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
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
      })
    });
  } catch (error) {
    throw new Error(`LM Studio provider request failed: ${error.message}`);
  }

  if (!response.ok) {
    throw new Error(`LM Studio provider request failed with status ${response.status}.`);
  }

  const payload = await response.json();
  const text = payload?.choices?.[0]?.message?.content;

  if (typeof text !== "string" || text.trim() === "") {
    throw new Error("LM Studio provider returned no message content.");
  }

  return text;
}
