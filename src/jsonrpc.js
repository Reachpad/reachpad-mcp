/** JSON-RPC 2.0 envelope checks shared by stdio and Streamable HTTP. */

// Keep the two transports on one request-size policy.
export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const PROTOCOL_VERSION = '2025-06-18';

/**
 * Return a stable, payload-free diagnostic when a single value is not a
 * JSON-RPC 2.0 Request object. A malformed value is not a notification, even
 * when it has no id: the server must answer it with Invalid Request.
 */
export function requestProblem(message) {
  if (!isRecord(message)) return 'invalid request: expected a JSON object';
  if (!Object.hasOwn(message, 'jsonrpc') || message.jsonrpc !== '2.0') {
    return 'invalid request: jsonrpc must be exactly "2.0"';
  }
  if (!Object.hasOwn(message, 'method') || typeof message.method !== 'string') {
    return 'invalid request: method must be a string';
  }
  if (Object.hasOwn(message, 'id') && !validId(message.id)) {
    return 'invalid request: id must be a string or finite number';
  }
  if (Object.hasOwn(message, 'params') && !isRecord(message.params)) {
    return 'invalid request: params must be an object when present';
  }
  return null;
}

/**
 * MCP removed JSON-RPC batching in protocol revision 2025-06-18. An array is
 * therefore one invalid payload, not a container whose members may dispatch.
 */
export function payloadProblem(payload) {
  if (Array.isArray(payload)) return 'invalid request: JSON-RPC batches are not supported';
  return requestProblem(payload);
}

export function isNotification(message) {
  return !Object.hasOwn(message, 'id');
}

function validId(value) {
  return (
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
