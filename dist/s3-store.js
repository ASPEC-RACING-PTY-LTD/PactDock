// StorePort over S3-compatible object storage (Amazon S3, Cloudflare R2).
// Records are created with `If-None-Match: *`, so an existing record is never overwritten.
import { S3Client, S3PreconditionError } from "./s3.js";
export class S3Store {
    label;
    #client;
    constructor(options) {
        this.#client = options instanceof S3Client ? options : new S3Client(options);
        this.label = this.#client.label;
    }
    async read(path) {
        const object = await this.#client.get(path);
        return object ? { text: object.body.toString("utf8") } : null;
    }
    async list(directory) {
        const prefix = directory.endsWith("/") ? directory : `${directory}/`;
        const keys = await this.#client.list(prefix, 500);
        return keys.map((k) => k.slice(prefix.length)).filter((name) => name && !name.includes("/"));
    }
    async create(path, text, _message) {
        try {
            await this.#client.put(path, Buffer.from(text, "utf8"), { contentType: "application/json", ifNoneMatch: true });
            return "created";
        }
        catch (err) {
            if (err instanceof S3PreconditionError) {
                // 412: already exists. 409: concurrent request; confirm by reading.
                if (await this.read(path))
                    return "exists";
            }
            throw err;
        }
    }
}
