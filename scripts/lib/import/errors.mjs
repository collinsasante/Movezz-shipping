export class ImportError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.name = "ImportError"; this.code = code; }
}
/** Raised by the environment guard: the importer refuses to run. */
export class ImportRefusal extends ImportError {
  constructor(message, checks = []) { super("IMPORT_REFUSED", message); this.name = "ImportRefusal"; this.checks = checks; }
}
