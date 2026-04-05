const STORAGE_KEYS = {
    stashId: "stash.id",
    stashKey: "stash.key",
    sessionToken: "stash.session",
};

const toBase64 = bytes => btoa(String.fromCharCode(...bytes));
const fromBase64 = b64 => new Uint8Array(atob(b64).split("").map(c => c.charCodeAt(0)));
const toHex = bytes => Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");

const generateStashKey = async () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
const exportKeyBytes = async key => new Uint8Array(await crypto.subtle.exportKey("raw", key));

async function deriveSubKey(stashKeyBytes, info, usage) {
    const base = await crypto.subtle.importKey("raw", stashKeyBytes, { name: "HKDF" }, false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode(info) },
        base,
        { name: "AES-GCM", length: 256 },
        true,
        usage
    );
}

async function deriveWrappingKey(password, salt) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), { name: "PBKDF2" }, false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
        { name: "PBKDF2", hash: "SHA-256", salt, iterations: 200_000 },
        base,
        { name: "AES-GCM", length: 256 },
        false,
        ["wrapKey", "unwrapKey"]
    );
}

async function wrapStashKey(stashKey, wrappingKey) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const wrapped = await crypto.subtle.wrapKey("raw", stashKey, wrappingKey, { name: "AES-GCM", iv });
    return { iv: toBase64(iv), encryptedKey: toBase64(new Uint8Array(wrapped)) };
}

async function unwrapStashKey(encryptedKey, iv, wrappingKey) {
    return crypto.subtle.unwrapKey(
        "raw", fromBase64(encryptedKey), wrappingKey,
        { name: "AES-GCM", iv: fromBase64(iv) },
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
    );
}

let bip39 = null;
async function getBip39() {
    if (!bip39) {
        const [{ entropyToMnemonic, mnemonicToEntropy }, { wordlist }] = await Promise.all([
            import("https://esm.sh/@scure/bip39@1.3.0"),
            import("https://esm.sh/@scure/bip39@1.3.0/wordlists/english"),
        ]);

        bip39 = { entropyToMnemonic, mnemonicToEntropy, wordlist };
    }

    return bip39;
}

const keyToPhrase = async bytes => {
    const { entropyToMnemonic, wordlist } = await getBip39();
    return entropyToMnemonic(bytes.slice(0, 16), wordlist);
};
const phraseToBytes = async phrase => {
    const { mnemonicToEntropy, wordlist } = await getBip39();
    return new Uint8Array(mnemonicToEntropy(phrase.trim(), wordlist));
};

const getAuthVerifier = async stashKeyBytes => {
    const authKey = await deriveSubKey(stashKeyBytes, "stash:auth", ["encrypt", "decrypt"]);
    return toBase64(await exportKeyBytes(authKey));
};

async function apiCreateStash({ id, authVerifier, recoveryId, recovery }) {
    const res = await fetch("/stash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, authVerifier, recoveryId, recovery }),
    });

    if (!res.ok) throw new Error((await res.json()).error);
}

async function apiGetChallenge(stashId) {
    const res = await fetch(`/stash/${stashId}/challenge`);
    if (!res.ok) throw new Error("Challenge failed");
    return res.json();
}

async function apiAuth(stashId, response) {
    const res = await fetch(`/stash/${stashId}/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response }),
    });

    if (!res.ok) throw new Error("Auth Failed");
    return res.json();
}

async function authenticate(stashId, stashKeyBytes) {
    const { nonce } = await apiGetChallenge(stashId);

    const authKey = await deriveSubKey(stashKeyBytes, "stash:auth", ["encrypt", "decrypt"]);
    const authBytes = await exportKeyBytes(authKey);
    const hmacKey = await crypto.subtle.importKey("raw", authBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(nonce));
    const response = toHex(new Uint8Array(sig));

    const { token } = await apiAuth(stashId, response);
    localStorage.setItem(STORAGE_KEYS.sessionToken, token);
    return token;
}

async function apiJoinByCode(code) {
    const res = await fetch(`/stash/join/${code}`, { method: "POST" });
    if (!res.ok) throw new Error("Invalid or expired code");
    return res.json();
}

async function apiGetRecovery(stashId) {
    const res = await fetch(`/stash/${stashId}/recovery`);
    if (!res.ok) throw new Error("Stash not found");
    return res.json();
}

async function deriveRecoveryId(stashKeyBytes) {
    const base = await crypto.subtle.importKey("raw", stashKeyBytes, { name: "HKDF" }, false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode("stash:recovery-id") },
        base, 128
    );
    return toHex(new Uint8Array(bits));
}

async function apiGetRecoveryByRecoveryId(recoveryId) {
    const res = await fetch(`/recovery/${recoveryId}`);
    if (!res.ok) throw new Error("Stash not found - check your phrase.");
    return res.json();
}