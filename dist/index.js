// Action entry point: reads inputs and environment, builds authenticated
// clients with least privilege, runs PactDock and fails closed on any error.
import { readFileSync } from "node:fs";
import { createInstallationToken } from "./app-auth.js";
import { GitHubRepo, GitHubStore } from "./github.js";
import { Http } from "./http.js";
import { PactDock } from "./pactdock.js";
import { appendSummary, getInput, log, setOutput, setSecret } from "./runtime.js";
export async function main(env = process.env) {
    let pactdock = null;
    try {
        const repository = env["GITHUB_REPOSITORY"] ?? "";
        const [owner, repo] = repository.split("/");
        if (!owner || !repo)
            throw new Error("GITHUB_REPOSITORY is not set; PactDock must run inside GitHub Actions.");
        const eventPath = env["GITHUB_EVENT_PATH"];
        if (!eventPath)
            throw new Error("GITHUB_EVENT_PATH is not set.");
        const apiUrl = env["GITHUB_API_URL"] ?? "https://api.github.com";
        const graphqlUrl = env["GITHUB_GRAPHQL_URL"] ?? `${apiUrl}/graphql`;
        const serverUrl = env["GITHUB_SERVER_URL"] ?? "https://github.com";
        const http = { apiUrl, graphqlUrl };
        const githubToken = getInput("github-token", env);
        const appId = getInput("app-id", env);
        const appKey = getInput("app-private-key", env);
        const storeToken = getInput("store-token", env);
        if (appKey)
            setSecret(appKey);
        if (storeToken)
            setSecret(storeToken);
        if (Boolean(appId) !== Boolean(appKey))
            throw new Error("app-id and app-private-key must be supplied together.");
        let repoToken = githubToken;
        if (appId) {
            repoToken = await createInstallationToken(http, appId, appKey, owner, repo, {
                statuses: "write",
                pull_requests: "write",
                issues: "write",
                contents: "read",
            });
            setSecret(repoToken);
        }
        if (!repoToken)
            throw new Error("No GitHub token available: set github-token (default) or app-id/app-private-key.");
        const makeStore = async (storage) => {
            const self = storage.repository === "self";
            const [storeOwner, storeRepo] = self ? [owner, repo] : storage.repository.split("/");
            let token = storeToken;
            if (!token && appId) {
                token = await createInstallationToken(http, appId, appKey, storeOwner, storeRepo, { contents: "write" });
                setSecret(token);
            }
            if (!token && self)
                token = githubToken;
            if (!token) {
                throw new Error(`No credentials for signature store ${storage.repository}: supply app-id/app-private-key or store-token.`);
            }
            return new GitHubStore(new Http({ ...http, token }), storeOwner, storeRepo, storage.branch);
        };
        const prInput = getInput("pull-request", env);
        const ctx = {
            eventName: env["GITHUB_EVENT_NAME"] ?? "",
            payload: JSON.parse(readFileSync(eventPath, "utf8")),
            serverUrl,
            runUrl: `${serverUrl}/${owner}/${repo}/actions/runs/${env["GITHUB_RUN_ID"] ?? ""}`,
            configPath: getInput("config-path", env) || ".github/pactdock.json",
        };
        if (prInput) {
            if (!/^\d{1,10}$/.test(prInput))
                throw new Error("pull-request must be a pull request number.");
            ctx.pullRequest = Number(prInput);
        }
        pactdock = new PactDock(ctx, new GitHubRepo(new Http({ ...http, token: repoToken }), owner, repo), makeStore, log);
        const outcome = await pactdock.run();
        setOutput("result", outcome.result);
        setOutput("unsigned", outcome.unsigned.join(","));
        setOutput("checked", outcome.checked.join(","));
        appendSummary(`### PactDock\n\n${outcome.message}`);
        log.info(outcome.message);
        return 0;
    }
    catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (pactdock)
            await pactdock.reportFailure(error);
        log.error(error.message);
        setOutput("result", "error");
        return 1;
    }
}
process.exitCode = await main();
