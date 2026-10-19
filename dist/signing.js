// Signing phrases and comment parsing. A signature is only recognised when the
// whole comment is exactly the phrase for the *current* agreement version
// (whitespace, quote style and letter case are normalised). Quoted replies,
// extra prose or old versions do not count, so acceptance is always explicit.
const ENTITY_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} .,&'()\/-]{1,149}$/u;
export function individualPhrase(agreement) {
    return `I have read and agree to the ${agreement.name} version ${agreement.version}.`;
}
export function entityPhrase(agreement, entityName = "<legal name of entity>") {
    return `I have read and agree to the ${agreement.name} version ${agreement.version} on behalf of ${entityName}, and I am authorised to bind it.`;
}
export function normalise(text) {
    return text
        .normalize("NFKC")
        .replace(/[‘’ʼ]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
export function isValidEntityName(name) {
    return ENTITY_NAME_RE.test(name);
}
export function parseComment(body, individual, entity) {
    const text = normalise(body);
    if (text === "/pactdock recheck")
        return { kind: "recheck" };
    const ind = normalise(individualPhrase(individual));
    if (text === ind || text === ind.replace(/\.$/, ""))
        return { kind: "individual" };
    if (entity) {
        const prefix = escapeRegExp(normalise(`I have read and agree to the ${entity.name} version ${entity.version} on behalf of `));
        const suffix = escapeRegExp(normalise(", and I am authorised to bind it"));
        const match = new RegExp(`^${prefix}(.+?)${suffix}\\.?$`, "u").exec(text);
        if (match?.[1]) {
            // Recover the entity name with its original capitalisation.
            const original = body.normalize("NFKC").replace(/\s+/g, " ").trim();
            const start = original.toLowerCase().indexOf(match[1]);
            const entityName = start >= 0 ? original.slice(start, start + match[1].length).trim() : match[1].trim();
            if (isValidEntityName(entityName))
                return { kind: "entity", entityName };
        }
    }
    return { kind: "none" };
}
/** Lower-case, dash-separated file name for an entity record. */
export function entitySlug(name) {
    const slug = name
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64)
        .replace(/-+$/g, "");
    if (!slug)
        throw new Error("Entity name does not produce a usable identifier.");
    return slug;
}
