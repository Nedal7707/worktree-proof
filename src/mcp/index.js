/** Public optional MCP surface. Importing this module performs no I/O. */
export {
  DEFAULT_MAX_MESSAGE_BYTES,
  MAX_ID_LENGTH,
  MAX_METHOD_LENGTH,
  McpError,
  createLineDecoder,
  isJsonRpcNotification,
  jsonRpcError,
  parseJsonRpcLine,
} from './framing.js';
export {
  DEFAULT_TOOL_LIMITS,
  McpToolError,
  createMcpToolRegistry,
  listMcpTools,
  safeStringify,
  sanitizeJson,
} from './tools.js';
export {
  DEFAULT_MCP_LIMITS,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_INFO,
  createMcpServer,
  handleMcpMessage,
} from './server.js';
