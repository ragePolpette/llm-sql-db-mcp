import {
  buildPolicyInfo,
  toSafeTargetInfo,
  toSafeTargetSummary
} from "./policy-engine.js";

function createJsonResult(payload) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ],
    structuredContent: payload
  };
}

function createErrorResult(message, details = {}) {
  return {
    content: [
      {
        type: "text",
        text: message
      }
    ],
    structuredContent: {
      error: message,
      ...details
    },
    isError: true
  };
}

export function createHandlers({ targetRegistry }) {
  return {
    async dbTargetList() {
      return createJsonResult({
        targets: targetRegistry.list().map(toSafeTargetSummary)
      });
    },

    async dbTargetInfo({ target_id: targetId }) {
      const target = targetRegistry.get(targetId);
      if (!target) {
        return createErrorResult(`Unknown target_id: ${targetId}`, {
          target_id: targetId
        });
      }

      if (target.status !== "active") {
        return createErrorResult(`Target "${targetId}" is disabled.`, {
          target_id: targetId,
          status: target.status
        });
      }

      return createJsonResult(toSafeTargetInfo(target));
    },

    async dbPolicyInfo({ target_id: targetId, tool_name: toolName }) {
      const target = targetRegistry.get(targetId);
      if (!target) {
        return createErrorResult(`Unknown target_id: ${targetId}`, {
          target_id: targetId
        });
      }

      return createJsonResult(buildPolicyInfo(target, toolName));
    }
  };
}
