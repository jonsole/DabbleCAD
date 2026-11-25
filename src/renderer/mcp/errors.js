// An error a tool reports back to the AI app: a short code it can act on, and a message.
export class ToolError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
