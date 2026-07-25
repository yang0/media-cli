export class DolaCliError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DolaCliError";
    this.code = code;
    this.details = details;
  }
}
