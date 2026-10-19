// Minimal S3-compatible object storage client (Amazon S3, Cloudflare R2, ...)
// using AWS Signature Version 4 implemented with node:crypto. No dependencies.
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
import { createHash, createHmac } from "node:crypto";
export class S3Error extends Error {
    status;
    constructor(method, key, status, detail) {
        super(`S3 ${method} ${key} failed with HTTP ${status}${detail ? `: ${detail}` : ""}`);
        this.name = "S3Error";
        this.status = status;
    }
}
/** Thrown when a conditional write's precondition fails (object exists / changed). */
export class S3PreconditionError extends Error {
    constructor(key) {
        super(`S3 conditional write rejected for ${key}`);
        this.name = "S3PreconditionError";
    }
}
const sha256hex = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
/** RFC 3986 encoding as required by SigV4. */
export function uriEncode(value, encodeSlash = true) {
    let out = encodeURIComponent(value).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
    if (!encodeSlash)
        out = out.replace(/%2F/g, "/");
    return out;
}
/** Returns the headers to send, including Authorization. Header names are lower-cased. */
export function signV4(input) {
    const amzDate = input.date.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const day = amzDate.slice(0, 8);
    const headers = {};
    for (const [k, v] of Object.entries(input.headers))
        headers[k.toLowerCase()] = v.trim().replace(/\s+/g, " ");
    headers["host"] = input.url.host;
    headers["x-amz-date"] = amzDate;
    if (input.credentials.sessionToken)
        headers["x-amz-security-token"] = input.credentials.sessionToken;
    const signedNames = Object.keys(headers).sort();
    const canonicalHeaders = signedNames.map((n) => `${n}:${headers[n]}\n`).join("");
    const query = [...input.url.searchParams.entries()]
        .map(([k, v]) => [uriEncode(k), uriEncode(v)])
        .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
        .map(([k, v]) => `${k}=${v}`)
        .join("&");
    // The URL pathname is already percent-encoded once; S3 must not double-encode.
    const canonicalRequest = [input.method, input.url.pathname || "/", query, canonicalHeaders, signedNames.join(";"), input.payloadHash].join("\n");
    const scope = `${day}/${input.region}/${input.service}/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");
    const kDate = hmac("AWS4" + input.credentials.secretAccessKey, day);
    const kSigning = hmac(hmac(hmac(kDate, input.region), input.service), "aws4_request");
    const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
    headers["authorization"] = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedNames.join(";")}, Signature=${signature}`;
    return headers;
}
export class S3Client {
    #o;
    constructor(options) {
        if (options.endpoint && !options.endpoint.startsWith("https://"))
            throw new Error("S3 endpoint must use https://");
        if (!options.credentials.accessKeyId || !options.credentials.secretAccessKey)
            throw new Error("S3 credentials are missing.");
        this.#o = {
            bucket: options.bucket,
            region: options.region,
            endpoint: options.endpoint?.replace(/\/+$/, ""),
            pathStyle: options.pathStyle ?? Boolean(options.endpoint),
            credentials: options.credentials,
            fetchImpl: options.fetchImpl ?? fetch,
            now: options.now ?? (() => new Date()),
        };
    }
    get label() {
        return `s3://${this.#o.bucket}${this.#o.endpoint ? ` (${new URL(this.#o.endpoint).host})` : ""}`;
    }
    #url(key, query = {}) {
        const path = key ? "/" + uriEncode(key, false) : "/";
        const { bucket, endpoint, pathStyle, region } = this.#o;
        const base = endpoint ?? `https://s3.${region}.amazonaws.com`;
        const url = pathStyle ? new URL(`${base}/${uriEncode(bucket)}${path === "/" ? "" : path}`) : new URL(path, base.replace("://", `://${bucket}.`));
        for (const [k, v] of Object.entries(query))
            url.searchParams.set(k, v);
        return url;
    }
    async #send(method, url, body, extra = {}) {
        const payloadHash = sha256hex(body ?? "");
        const headers = signV4({
            method,
            url,
            headers: { "x-amz-content-sha256": payloadHash, ...extra },
            payloadHash,
            region: this.#o.region,
            service: "s3",
            credentials: this.#o.credentials,
            date: this.#o.now(),
        });
        delete headers["host"]; // fetch sets Host itself
        const init = { method, headers, redirect: "error" };
        if (body)
            init.body = new Uint8Array(body);
        let lastError;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const res = await this.#o.fetchImpl(url, init);
                if (res.status >= 500 && attempt < 3) {
                    await res.body?.cancel();
                    continue;
                }
                return res;
            }
            catch (err) {
                lastError = err;
            }
        }
        throw new Error(`Network request to object storage failed: ${String(lastError)}`);
    }
    async get(key) {
        const res = await this.#send("GET", this.#url(key), undefined);
        if (res.status === 404) {
            await res.body?.cancel();
            return null;
        }
        const body = Buffer.from(await res.arrayBuffer());
        if (!res.ok)
            throw new S3Error("GET", key, res.status, xmlCode(body.toString("utf8")));
        return { body, etag: res.headers.get("etag") ?? "" };
    }
    /** Writes an object. `ifNoneMatch` creates only if absent; `ifMatch` replaces only if unchanged. */
    async put(key, body, options = {}) {
        const headers = { "content-type": options.contentType ?? "application/octet-stream" };
        if (options.ifNoneMatch)
            headers["if-none-match"] = "*";
        if (options.ifMatch)
            headers["if-match"] = options.ifMatch;
        const res = await this.#send("PUT", this.#url(key), body, headers);
        const text = await res.text();
        if (res.status === 412 || res.status === 409)
            throw new S3PreconditionError(key);
        if (!res.ok)
            throw new S3Error("PUT", key, res.status, xmlCode(text));
    }
    /** Lists object keys directly under a prefix (delimiter "/"). Fails closed above `max`. */
    async list(prefix, max = 1000) {
        const keys = [];
        let token = null;
        do {
            const query = { "list-type": "2", prefix, delimiter: "/" };
            if (token)
                query["continuation-token"] = token;
            const res = await this.#send("GET", this.#url("", query), undefined);
            const text = await res.text();
            if (!res.ok)
                throw new S3Error("LIST", prefix, res.status, xmlCode(text));
            keys.push(...parseListKeys(text));
            if (keys.length > max)
                throw new Error(`More than ${max} objects under ${prefix}; refusing to continue.`);
            token = /<IsTruncated>true<\/IsTruncated>/.test(text) ? (xmlValue(text, "NextContinuationToken") ?? null) : null;
        } while (token);
        return keys;
    }
}
function decodeXml(text) {
    return text.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, e) => {
        if (e === "lt")
            return "<";
        if (e === "gt")
            return ">";
        if (e === "amp")
            return "&";
        if (e === "quot")
            return '"';
        if (e === "apos")
            return "'";
        return String.fromCodePoint(e.startsWith("#x") ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    });
}
function xmlValue(xml, tag) {
    const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
    return m?.[1] === undefined ? undefined : decodeXml(m[1]);
}
function xmlCode(xml) {
    return xmlValue(xml, "Code") ?? "";
}
export function parseListKeys(xml) {
    const keys = [];
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = xmlValue(m[1] ?? "", "Key");
        if (key !== undefined)
            keys.push(key);
    }
    return keys;
}
