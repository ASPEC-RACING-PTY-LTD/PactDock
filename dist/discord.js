// Optional Discord logging via an incoming webhook. Discord is a log only:
// PactDock never reads signatures back from it, so a readable store (GitHub,
// S3/R2) is always required. Failures to post never block a check.
const WEBHOOK_RE = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,30}\/[A-Za-z0-9_-]{20,200}$/;
export function isDiscordWebhookUrl(url) {
    return WEBHOOK_RE.test(url);
}
/** Removes Discord markdown/mention syntax from untrusted text. */
function plain(text) {
    return text.replace(/[\\`*_~|>#@<\[\]()]/g, "").slice(0, 200);
}
export function discordMessage(event) {
    const e = event.entry;
    const what = event.kind === "entity" ? `the ${plain(e.agreementName)} v${plain(e.version)} on behalf of ${plain(event.entityName ?? "")} (pending maintainer approval)` : `the ${plain(e.agreementName)} v${plain(e.version)}`;
    const where = e.evidence.repository ? ` in ${plain(e.evidence.repository)}${e.evidence.pullRequest ? ` PR #${e.evidence.pullRequest}` : ""}` : "";
    return [`**CLA signed:** ${plain(e.signer.login)} (GitHub ID ${e.signer.id}) accepted ${what}${where}.`, `Signed at ${e.signedAt}. Stored in ${plain(event.storeLabel)}.`].join("\n");
}
export async function postToDiscord(webhookUrl, mode, event, fetchImpl = fetch) {
    if (!isDiscordWebhookUrl(webhookUrl))
        throw new Error("The Discord webhook URL is not a valid discord.com webhook URL.");
    // Never ping anyone, whatever the text contains.
    const payload = { content: discordMessage(event), allowed_mentions: { parse: [] } };
    let init;
    if (mode === "signature") {
        const form = new FormData();
        const name = `pactdock-${event.entry.agreementId}-${event.entry.version}-${event.entry.signer.id}.json`;
        form.append("payload_json", JSON.stringify({ ...payload, attachments: [{ id: 0, filename: name }] }));
        form.append("files[0]", new Blob([event.recordJson], { type: "application/json" }), name);
        init = { method: "POST", body: form };
    }
    else {
        init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) };
    }
    const res = await fetchImpl(`${webhookUrl}?wait=true`, { ...init, redirect: "error" });
    if (!res.ok)
        throw new Error(`Discord webhook returned HTTP ${res.status}.`);
    await res.body?.cancel();
}
