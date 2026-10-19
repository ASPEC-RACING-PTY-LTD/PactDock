// GitHub API implementations of RepoPort and StorePort.
import { GitHubApiError, Http } from "./http.js";
import {} from "./types.js";
const enc = encodeURIComponent;
function encPath(path) {
    return path.split("/").map(enc).join("/");
}
function toComment(c) {
    return {
        id: c.id,
        body: c.body ?? "",
        user: { id: c.user?.id ?? 0, login: c.user?.login ?? "ghost", type: c.user?.type ?? "User" },
        createdAt: c.created_at,
        updatedAt: c.updated_at,
        htmlUrl: c.html_url,
    };
}
async function readContent(http, base, path, ref) {
    const query = ref ? `?ref=${enc(ref)}` : "";
    return http.request("GET", `${base}/contents/${encPath(path)}${query}`, { allow404: true });
}
function decodeFile(content, path) {
    if (Array.isArray(content) || content.type !== "file")
        throw new Error(`${path} is not a file.`);
    if (content.encoding !== "base64" || content.content === undefined) {
        throw new Error(`${path} is too large to read through the contents API (limit 1 MB).`);
    }
    return Buffer.from(content.content, "base64");
}
export class GitHubRepo {
    owner;
    repo;
    #http;
    #base;
    constructor(http, owner, repo) {
        this.#http = http;
        this.owner = owner;
        this.repo = repo;
        this.#base = `/repos/${enc(owner)}/${enc(repo)}`;
    }
    async getDefaultBranchHead() {
        const repo = await this.#http.request("GET", this.#base);
        const commit = await this.#http.request("GET", `${this.#base}/commits/${enc(repo.default_branch)}`);
        return { branch: repo.default_branch, sha: commit.sha };
    }
    async getFile(path, ref) {
        const content = await readContent(this.#http, this.#base, path, ref);
        return content ? decodeFile(content, path) : null;
    }
    async getPullRequest(number) {
        const pr = await this.#http.request("GET", `${this.#base}/pulls/${number}`);
        return {
            number: pr.number,
            state: pr.state,
            headSha: pr.head.sha,
            author: { id: pr.user.id, login: pr.user.login, type: pr.user.type },
            htmlUrl: pr.html_url,
        };
    }
    async getPullRequestCommits(number, limit) {
        const query = `query($owner:String!,$name:String!,$number:Int!,$after:String){
      repository(owner:$owner,name:$name){ pullRequest(number:$number){
        headRefOid
        commits(first:100, after:$after){
          totalCount
          pageInfo{ hasNextPage endCursor }
          nodes{ commit{
            oid
            authors(first:25){ totalCount nodes{ name email user{ databaseId login } } }
            committer{ name email user{ databaseId login } }
          } }
        }
      } }
    }`;
        const toIdentity = (a) => ({
            name: a.name ?? "",
            email: a.email ?? "",
            user: a.user ? { id: a.user.databaseId, login: a.user.login } : null,
        });
        const commits = [];
        let after = null;
        let headSha = "";
        let totalCount = 0;
        do {
            const data = await this.#http.graphql(query, { owner: this.owner, name: this.repo, number, after });
            const pr = data.repository?.pullRequest;
            if (!pr)
                throw new Error(`Pull request #${number} was not found.`);
            if (headSha && headSha !== pr.headRefOid)
                throw new Error("Pull request head changed while reading commits; retry.");
            headSha = pr.headRefOid;
            totalCount = pr.commits.totalCount;
            if (totalCount > limit)
                break;
            for (const node of pr.commits.nodes) {
                commits.push({
                    oid: node.commit.oid,
                    authors: node.commit.authors.nodes.map(toIdentity),
                    authorsTruncated: node.commit.authors.totalCount > node.commit.authors.nodes.length,
                    committer: toIdentity(node.commit.committer),
                });
            }
            after = pr.commits.pageInfo.hasNextPage ? pr.commits.pageInfo.endCursor : null;
        } while (after);
        return { headSha, totalCount, commits };
    }
    async listOpenPullRequests(limit) {
        const prs = await this.#http.paginate(`${this.#base}/pulls?state=open`, limit);
        return prs.map((p) => p.number);
    }
    async getComment(id) {
        const c = await this.#http.request("GET", `${this.#base}/issues/comments/${id}`, { allow404: true });
        return c ? toComment(c) : null;
    }
    async listComments(issue) {
        const list = await this.#http.paginate(`${this.#base}/issues/${issue}/comments`, 3000);
        return list.map(toComment);
    }
    async createComment(issue, body) {
        await this.#http.request("POST", `${this.#base}/issues/${issue}/comments`, { body: { body } });
    }
    async updateComment(id, body) {
        await this.#http.request("PATCH", `${this.#base}/issues/comments/${id}`, { body: { body } });
    }
    async addReaction(commentId, content) {
        await this.#http.request("POST", `${this.#base}/issues/comments/${commentId}/reactions`, { body: { content } });
    }
    async setStatus(sha, state, context, description, targetUrl) {
        await this.#http.request("POST", `${this.#base}/statuses/${enc(sha)}`, {
            body: { state, context, description: description.slice(0, 140), target_url: targetUrl },
        });
    }
}
export class GitHubStore {
    label;
    #http;
    #base;
    #branch;
    constructor(http, owner, repo, branch) {
        this.#http = http;
        this.#base = `/repos/${enc(owner)}/${enc(repo)}`;
        this.#branch = branch;
        this.label = `${owner}/${repo}${branch ? `@${branch}` : ""}`;
    }
    async read(path) {
        const content = await readContent(this.#http, this.#base, path, this.#branch);
        if (!content)
            return null;
        if (Array.isArray(content))
            throw new Error(`${path} is a directory.`);
        return { text: decodeFile(content, path).toString("utf8") };
    }
    async list(directory) {
        const content = await readContent(this.#http, this.#base, directory, this.#branch);
        if (!content)
            return [];
        if (!Array.isArray(content))
            throw new Error(`${directory} is not a directory.`);
        return content.filter((c) => c.type === "file").map((c) => c.name);
    }
    async create(path, text, message) {
        const body = { message, content: Buffer.from(text, "utf8").toString("base64") };
        if (this.#branch)
            body["branch"] = this.#branch;
        try {
            // No blob sha supplied: GitHub refuses to overwrite an existing file.
            await this.#http.request("PUT", `${this.#base}/contents/${encPath(path)}`, { body });
            return "created";
        }
        catch (err) {
            // 422 complaining about the missing sha means the file already exists; 409 is a
            // concurrent create. Other errors (e.g. a missing branch) must surface.
            if (err instanceof GitHubApiError && (err.status === 409 || (err.status === 422 && /sha/i.test(err.message)))) {
                if (await this.read(path))
                    return "exists";
            }
            throw err;
        }
    }
}
