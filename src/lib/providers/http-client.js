class ProviderResponseError extends Error {}

function buildUrl(baseUrl, path) {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

function createTimeoutError(label, timeoutMs) {
  return new DOMException(`${label} provider request timed out after ${timeoutMs}ms.`, "AbortError");
}

/**
 * Shared JSON-over-HTTP chat call used by every provider adapter. The timeout covers both the
 * request and the response body, so a provider that stalls while streaming the body still fails.
 */
export async function requestProviderChat({ adapter, baseUrl, model, systemPrompt, userPrompt, fetchImpl, timeoutMs }) {
  const controller = timeoutMs ? new AbortController() : null;
  const timeout = controller
    ? setTimeout(() => controller.abort(createTimeoutError(adapter.label, timeoutMs)), timeoutMs)
    : null;

  try {
    const response = await fetchImpl(buildUrl(baseUrl, adapter.path), {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(adapter.buildBody({ model, systemPrompt, userPrompt })),
      signal: controller?.signal
    });

    if (!response.ok) {
      throw new ProviderResponseError(`${adapter.label} provider request failed with status ${response.status}.`);
    }

    const text = adapter.extractText(await response.json());
    if (typeof text !== "string" || text.trim() === "") {
      throw new ProviderResponseError(`${adapter.label} provider returned no message content.`);
    }

    return text;
  } catch (error) {
    if (controller?.signal.aborted || error?.name === "AbortError") {
      throw new Error(`${adapter.label} provider request timed out after ${timeoutMs}ms.`, { cause: error });
    }
    if (error instanceof ProviderResponseError) {
      throw new Error(error.message, { cause: error });
    }
    throw new Error(`${adapter.label} provider request failed: ${error?.message ?? String(error)}`, { cause: error });
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
