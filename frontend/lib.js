// #region Utils

const STORAGE_KEYS = {
    stashId: "stash.id",
    stashKey: "stash.key",
    sessionToken: "stash.session",
    deviceId: "stash.deviceId",
};

const toBase64 = bytes => btoa(String.fromCharCode(...bytes));
const fromBase64 = b64 => new Uint8Array(atob(b64).split("").map(c => c.charCodeAt(0)));
const toHex = bytes => Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");

// #endregion

// #region Key Derivation

const generateStashKey = () =>
    crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);

const exportKeyBytes = async key =>
    new Uint8Array(await crypto.subtle.exportKey("raw", key));

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

async function deriveRecoveryId(stashKeyBytes) {
    const base = await crypto.subtle.importKey("raw", stashKeyBytes, { name: "HKDF" }, false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode("stash:recovery-id") },
        base, 128
    );
    return toHex(new Uint8Array(bits));
}

// #endregion

// #region Key Wrapping

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

// #endregion

// #region Recovery

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

// #endregion

// #region Auth

const getAuthVerifier = async stashKeyBytes => {
    const authKey = await deriveSubKey(stashKeyBytes, "stash:auth", ["encrypt", "decrypt"]);
    return toBase64(await exportKeyBytes(authKey));
};

async function authenticate(stashId, stashKeyBytes) {
    const { nonce } = await apiGetChallenge(stashId);

    const authKey = await deriveSubKey(stashKeyBytes, "stash:auth", ["encrypt", "decrypt"]);
    const authBytes = await exportKeyBytes(authKey);
    const hmacKey = await crypto.subtle.importKey("raw", authBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(nonce));
    const response = toHex(new Uint8Array(sig));

    const deviceId = localStorage.getItem(STORAGE_KEYS.deviceId);
    const { token, deviceId: resolvedDeviceId } = await apiAuth(stashId, response, deviceId);

    localStorage.setItem(STORAGE_KEYS.sessionToken, token);
    if (resolvedDeviceId) {
        localStorage.setItem(STORAGE_KEYS.deviceId, resolvedDeviceId);
    }

    return token;
}

// #endregion

// #region Crypto

async function encryptWithKey(key, plaintext) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
    const result = new Uint8Array(12 + ciphertext.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(ciphertext), 12);
    return result.buffer;
}

async function decryptWithKey(key, buffer) {
    const iv = new Uint8Array(buffer, 0, 12);
    const ciphertext = new Uint8Array(buffer, 12);
    return crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
}

async function encryptMetadata(metadata, stashKeyBytes) {
    const key = await deriveSubKey(stashKeyBytes, "stash:metadata", ["encrypt", "decrypt"]);
    const encoded = new TextEncoder().encode(JSON.stringify(metadata));
    return encryptWithKey(key, encoded);
}

async function decryptMetadata(buffer, stashKeyBytes) {
    const key = await deriveSubKey(stashKeyBytes, "stash:metadata", ["encrypt", "decrypt"]);
    const plaintext = await decryptWithKey(key, buffer);
    return JSON.parse(new TextDecoder().decode(plaintext));
}

async function encryptBlob(fileBytes, stashKeyBytes) {
    const key = await deriveSubKey(stashKeyBytes, "stash:files", ["encrypt", "decrypt"]);
    return encryptWithKey(key, fileBytes);
}

async function decryptBlob(buffer, stashKeyBytes) {
    const key = await deriveSubKey(stashKeyBytes, "stash:files", ["encrypt", "decrypt"]);
    return decryptWithKey(key, buffer);
}

// #endregion

// #region API

async function apiFetch(url, { token, ...opts } = {}) {
    const headers = { ...opts.headers };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(url, { ...opts, headers });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Request failed: ${res.status}`);
    }
    return res;
}

async function apiCreateStash({ id, authVerifier, recoveryId, recovery, device }) {
    const res = await apiFetch("/stash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, authVerifier, recoveryId, recovery, device }),
    });
    return res.json();
}

async function apiGetChallenge(stashId) {
    const res = await apiFetch(`/stash/${stashId}/challenge`);
    return res.json();
}

async function apiAuth(stashId, response, deviceId) {
    const res = await apiFetch(`/stash/${stashId}/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response, deviceId }),
    });
    return res.json();
}

async function apiGetMetadata(stashId, token) {
    const res = await fetch(`/stash/${stashId}/metadata`, {
        headers: { "Authorization": `Bearer ${token}` }
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error("Failed to fetch metadata");
    return res.arrayBuffer();
}

async function apiPutMetadata(stashId, token, buffer) {
    await apiFetch(`/stash/${stashId}/metadata`, {
        method: "PUT",
        token,
        headers: { "Content-Type": "application/octet-stream" },
        body: buffer,
    });
}

async function apiUploadBlob(stashId, token, buffer) {
    const res = await apiFetch(`/stash/${stashId}/blob`, {
        method: "POST",
        token,
        headers: { "Content-Type": "application/octet-stream" },
        body: buffer,
    });
    return res.json();
}

async function apiDownloadBlob(stashId, token, blobId) {
    const res = await apiFetch(`/stash/${stashId}/blob/${blobId}`, { token });
    return res.arrayBuffer();
}

async function apiJoinByCode(code, payload = {}) {
    const res = await apiFetch(`/stash/join/${encodeURIComponent(code)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });

    return res.json();
}

async function apiGetRecovery(stashId) {
    const res = await apiFetch(`/stash/${stashId}/recovery`);
    return res.json();
}

async function apiGetRecoveryByRecoveryId(recoveryId) {
    const res = await apiFetch(`/recovery/${recoveryId}`);
    return res.json();
}

async function apiListDevices(stashId, token) {
    const res = await apiFetch(`/stash/${stashId}/devices`, { token });
    return res.json();
}

async function apiRenameDevice(stashId, token, deviceId, name) {
    const res = await apiFetch(`/stash/${stashId}/devices/${deviceId}`, {
        method: "PATCH",
        token,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
    });
    return res.json();
}

async function apiRemoveDevice(stashId, token, deviceId) {
    await apiFetch(`/stash/${stashId}/devices/${deviceId}`, {
        method: "DELETE",
        token,
    });
}

async function apiCreateAccessCode(stashId, token, device) {
    const res = await apiFetch(`/stash/${stashId}/access-code`, {
        method: "POST",
        token,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device }),
    });
    return res.json();
}

async function apiPutAccessCodeTransfer(stashId, token, code, transfer) {
    const res = await apiFetch(`/stash/${stashId}/access-code/${encodeURIComponent(code)}`, {
        method: "PUT",
        token,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transfer }),
    });
    return res.json();
}

// #endregion