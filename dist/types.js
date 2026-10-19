// Shared domain types and the narrow GitHub "ports" PactDock depends on.
// Production code implements them over the GitHub API (github.ts); tests use
// in-memory fakes.
export class StoreConflictError extends Error {
    constructor(path) {
        super(`Concurrent modification of ${path} in the signature store.`);
        this.name = "StoreConflictError";
    }
}
