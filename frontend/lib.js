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

const CHUNK_SIZE = 2 * 1024 * 1024;
const BLOB_MAGIC = 0x53545348; // STSH

let cachedFileKey = null;
let cachedFileKeySource = null;

async function getFileKey(stashKeyBytes) {
    const source = localStorage.getItem(STORAGE_KEYS.stashKey);
    if (cachedFileKey && cachedFileKeySource === source) return cachedFileKey;
    cachedFileKey = await deriveSubKey(stashKeyBytes, "stash:files", ["encrypt", "decrypt"]);
    cachedFileKeySource = source;

    return cachedFileKey;
}

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
    return encryptWithKey(key, new TextEncoder().encode(JSON.stringify(metadata)));
}

async function decryptMetadata(buffer, stashKeyBytes) {
    const key = await deriveSubKey(stashKeyBytes, "stash:metadata", ["encrypt", "decrypt"]);
    return JSON.parse(new TextDecoder().decode(await decryptWithKey(key, buffer)));
}

async function encryptBlob(fileBytes, stashKeyBytes, onProgress, onChunk) {
    const key = await getFileKey(stashKeyBytes);
    const input = fileBytes instanceof ArrayBuffer ? new Uint8Array(fileBytes) : fileBytes;
    const originalSize = input.byteLength;
    const chunkCount = Math.max(1, Math.ceil(originalSize / CHUNK_SIZE));

    const headerBuf = new ArrayBuffer(21);
    const hv = new DataView(headerBuf);
    hv.setUint32(0, BLOB_MAGIC);
    hv.setUint8(4, 1);
    hv.setUint32(5, CHUNK_SIZE);
    hv.setUint32(9, chunkCount);
    hv.setUint32(13, Math.floor(originalSize / 0x100000000));
    hv.setUint32(17, originalSize >>> 0);

    await onChunk?.(0, headerBuf);

    for (let i = 0; i < chunkCount; i++) {
        const chunk = input.slice(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, originalSize));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, chunk);
        const out = new Uint8Array(12 + ct.byteLength);
        out.set(iv);
        out.set(new Uint8Array(ct), 12);
        onProgress?.((i + 1) / chunkCount);
        await onChunk?.(i + 1, out.buffer);
    }
}

async function decryptBlob(buffer, stashKeyBytes, onProgress) {
    const key = await getFileKey(stashKeyBytes);

    const dv = new DataView(buffer);
    const chunkSize = dv.getUint32(5);
    const chunkCount = dv.getUint32(9);
    const originalSize = dv.getUint32(13) * 0x100000000 + dv.getUint32(17);

    const result = new Uint8Array(originalSize);
    let readOff = 21, writeOff = 0;

    for (let i = 0; i < chunkCount; i++) {
        const isLast = i === chunkCount - 1;
        const plainLen = isLast ? (originalSize - i * chunkSize) : chunkSize;
        const iv = new Uint8Array(buffer, readOff, 12);

        readOff += 12;
        const ct = new Uint8Array(buffer, readOff, plainLen + 16);
        readOff += plainLen + 16;
        const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
        result.set(new Uint8Array(plain), writeOff);
        writeOff += plain.byteLength;
        onProgress?.((i + 1) / chunkCount);
    }

    return result.buffer;
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

async function apiStartBlobUpload(stashId, token, payload = {}) {
    const res = await apiFetch(`/stash/${stashId}/blob/start`, {
        method: "POST",
        token,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    return res.json();
}

async function apiUploadChunk(stashId, token, blobId, index, buffer) {
    await apiFetch(`/stash/${stashId}/blob/${blobId}/chunk/${index}`, {
        method: "PUT",
        token,
        headers: { "Content-Type": "application/octet-stream" },
        body: buffer,
    });
}

async function apiCompleteBlobUpload(stashId, token, blobId, chunkCount) {
    const res = await apiFetch(`/stash/${stashId}/blob/${blobId}/complete`, {
        method: "POST",
        token,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chunkCount }),
    });
    return res.json();
}

async function apiDownloadBlob(stashId, token, blobId, onProgress) {
    const res = await apiFetch(`/stash/${stashId}/blob/${blobId}`, { token });
    if (!onProgress) return res.arrayBuffer();

    const contentLength = parseInt(res.headers.get("Content-Length") || "0");
    if (!contentLength) return res.arrayBuffer();

    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        onProgress(received / contentLength);
    }

    const out = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out.buffer;
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

async function apiCreateRecoveryDevice(recoveryId, name, type) {
    const res = await apiFetch(`/recovery/${encodeURIComponent(recoveryId)}/device`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, type }),
    });
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

async function apiGetQuota(stashId, token) {
    const res = await apiFetch(`/stash/${stashId}/quota`, { token });
    return res.json();
}

// #endregion