// StorePort over S3-compatible object storage (Amazon S3, Cloudflare R2).
// Records are created with `If-None-Match: *`, so an existing record is never overwritten.

import { S3Client, S3PreconditionError, type S3Options } from "./s3.ts";
import type { StoredFile, StorePort } from "./types.ts";

export class S3Store implements StorePort {
  readonly label: string;
  readonly #client: S3Client;

  constructor(options: S3Options | S3Client) {
    this.#client = options instanceof S3Client ? options : new S3Client(options);
    this.label = this.#client.label;
  }

  async read(path: string): Promise<StoredFile | null> {
    const object = await this.#client.get(path);
    return object ? { text: object.body.toString("utf8") } : null;
  }

  async list(directory: string): Promise<string[]> {
    const prefix = directory.endsWith("/") ? directory : `${directory}/`;
    const keys = await this.#client.list(prefix, 500);
    return keys.map((k) => k.slice(prefix.length)).filter((name) => name && !name.includes("/"));
  }

  async create(path: string, text: string, _message?: string): Promise<"created" | "exists"> {
    try {
      await this.#client.put(path, Buffer.from(text, "utf8"), { contentType: "application/json", ifNoneMatch: true });
      return "created";
    } catch (err) {
      if (err instanceof S3PreconditionError) {
        // 412: already exists. 409: concurrent request; confirm by reading.
        if (await this.read(path)) return "exists";
      }
      throw err;
    }
  }
}
