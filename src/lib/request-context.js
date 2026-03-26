import { AsyncLocalStorage } from "node:async_hooks";

const requestContextStore = new AsyncLocalStorage();

function normalizeContext(context = {}) {
  return {
    request_id:
      typeof context.request_id === "string" && context.request_id.trim()
        ? context.request_id.trim()
        : null,
    session_id:
      typeof context.session_id === "string" && context.session_id.trim()
        ? context.session_id.trim()
        : null
  };
}

export function runWithRequestContext(context, callback) {
  return requestContextStore.run(normalizeContext(context), callback);
}

export function getRequestContext() {
  return requestContextStore.getStore() ?? null;
}

export const __requestContextTestUtils = {
  normalizeContext
};
