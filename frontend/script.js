const [createBtn, joinBtn] = document.querySelectorAll(".action");
let pendingStashId = null;
let pendingStashKeyBytes = null;

function openModal(html) {
    closeModal(true);

    const overlay = document.createElement("div");

    overlay.className = "modal-overlay";
    overlay.id = "modal-overlay";
    overlay.innerHTML = `<div class="modal">${html}<button class="modal-close">&#10005;</button></div>`;
    overlay.querySelector(".modal-close").onclick = () => closeModal();
    overlay.addEventListener("mousedown", e => { overlay._dragStartedInside = e.target !== overlay; });
    overlay.addEventListener("click", e => {
        if (e.target === overlay && !overlay._dragStartedInside) closeModal();
    });

    document.body.appendChild(overlay);

    return overlay.querySelector(".modal");
}

function closeModal(silent = false) {
    if (silent instanceof Event) silent = false;

    if (!silent && pendingStashId) {
        const id = pendingStashId;
        const keyBytes = pendingStashKeyBytes;
        pendingStashId = null;
        pendingStashKeyBytes = null;

        const clear = () => {
            localStorage.removeItem(STORAGE_KEYS.stashId);
            localStorage.removeItem(STORAGE_KEYS.stashKey);
            localStorage.removeItem(STORAGE_KEYS.deviceId);
            localStorage.removeItem(STORAGE_KEYS.sessionToken);
        };

        if (keyBytes) {
            authenticate(id, keyBytes)
                .then(() =>
                    fetch(`/stash/${id}`, {
                        method: "DELETE",
                        headers: {
                            Authorization: `Bearer ${localStorage.getItem(STORAGE_KEYS.sessionToken)}`
                        }
                    })
                )
                .then(clear)
                .catch(clear);
        } else {
            clear();
        }
    }

    const overlay = document.getElementById("modal-overlay");
    if (!overlay) return;
    overlay.classList.add("closing");
    overlay.addEventListener("animationend", () => overlay.remove(), { once: true });
}

async function createStash() {
    openModal(`
        <div class="modal-title">Creating your stash</div>
        <div class="modal-sub">Generating encryption keys...</div>
    `);

    try {
        const stashKey = await generateStashKey();
        const stashKeyBytes = await exportKeyBytes(stashKey);
        const stashId = crypto.randomUUID();

        const authVerifier = await getAuthVerifier(stashKeyBytes);

        const phrase = await keyToPhrase(stashKeyBytes);
        const salt = crypto.getRandomValues(new Uint8Array(32));
        const wrapKey = await deriveWrappingKey(phrase, salt);
        const { iv, encryptedKey } = await wrapStashKey(stashKey, wrapKey);

        const phraseBytes = await phraseToBytes(phrase);
        const recoveryId = await deriveRecoveryId(phraseBytes);

        const { deviceType, deviceName } = getDeviceInfo();
        const { device } = await apiCreateStash({
            id: stashId,
            authVerifier,
            recoveryId,
            recovery: { salt: toBase64(salt), kdfParams: { iterations: 200_000, hash: "SHA-256" }, iv, encryptedKey },
            device: { name: deviceName, type: deviceType },
        });

        pendingStashId = stashId;
        pendingStashKeyBytes = stashKeyBytes;

        localStorage.setItem(STORAGE_KEYS.stashId, stashId);
        localStorage.setItem(STORAGE_KEYS.stashKey, toBase64(stashKeyBytes));

        if (device?.id) {
            localStorage.setItem(STORAGE_KEYS.deviceId, device.id);
        }

        showRecoveryPhrase(phrase);
    } catch (err) {
        openModal(`
            <div class="modal-title">Something went wrong</div>
            <div class="modal-sub" style="color:#e06c6c">${err.message}</div>
        `);
    }
}

function showRecoveryPhrase(phrase) {
    openModal(`
        <div class="modal-title">Save your recovery phrase</div>
        <div style="
            background: rgba(224,154,108,0.08); border: 1px solid rgba(224,154,108,0.3);
            border-radius: 0.65rem; padding: 1rem 1.1rem; margin-bottom: 1.25rem;
            color: #e09a6c; font-size: 0.87rem; line-height: 1.6;
        ">
            <div style="font-weight:600; font-size:0.92rem; color:#eab97a;">
                Write this down somewhere safe.
            </div>
            <br>
            This is the <strong style="color:#eab97a">only way to recover your stash</strong> if you lose access to all your devices.<br><br>
            <strong style="color:#eab97a">It will not be shown again.</strong>
        </div>
        <div id="phrase-box" style="
            display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.55rem;
            background: rgba(139,126,200,0.07); border: 1px solid rgba(139,126,200,0.2);
            border-radius: 0.65rem; padding: 1.1rem 1.25rem; margin-bottom: 1.25rem;
        ">${phrase.split(" ").map(w => `
            <span style="
                font-family: monospace; font-size: 0.88rem;
                color: #c4b8e8; text-align: center; padding: 0.35rem 0;
            ">${w}</span>
        `).join("")}</div>
        <button class="modal-btn" id="copy-btn">Copy phrase</button>
        <button class="modal-btn primary" id="confirm-btn">I've saved it, continue</button>
    `);

    document.getElementById("copy-btn").onclick = () => {
        navigator.clipboard.writeText(phrase).then(() => {
            document.getElementById("copy-btn").textContent = "Copied!";
        });

        setTimeout(() => {
            document.getElementById("copy-btn").textContent = "Copy phrase";
        }, 2500);
    };

    const confirmBtn = document.getElementById("confirm-btn");
    let countdown = 5;
    confirmBtn.disabled = true;
    confirmBtn.textContent = `I've saved it, continue (${countdown}s)`;
    confirmBtn.style.opacity = "0.45";
    confirmBtn.style.cursor = "not-allowed";

    const tick = setInterval(() => {
        countdown--;
        if (countdown <= 0) {
            clearInterval(tick);
            confirmBtn.disabled = false;
            confirmBtn.textContent = "I've saved it, continue";
            confirmBtn.style.opacity = "";
            confirmBtn.style.cursor = "";
        } else {
            confirmBtn.textContent = `I've saved it, continue (${countdown}s)`;
        }
    }, 1000);

    confirmBtn.onclick = async () => {
        pendingStashId = null;
        pendingStashKeyBytes = null;

        closeModal();

        const stashId = localStorage.getItem(STORAGE_KEYS.stashId);
        const stashKeyBytes = fromBase64(localStorage.getItem(STORAGE_KEYS.stashKey));
        await authenticate(stashId, stashKeyBytes);
        enterStash();
    };
}

async function joinByCode(code, options = {}) {
    const normalizedCode = code.trim().toUpperCase();

    try {
        const { stashId, transfer, device } = await apiJoinByCode(normalizedCode, {
            secret: options.secret,
            deviceName: options.deviceName,
            deviceType: options.deviceType,
        });

        const wrapKey = await deriveWrappingKey(normalizedCode, fromBase64(transfer.salt));
        const stashKey = await unwrapStashKey(transfer.encryptedKey, transfer.iv, wrapKey);
        const stashKeyBytes = await exportKeyBytes(stashKey);

        localStorage.setItem(STORAGE_KEYS.stashId, stashId);
        localStorage.setItem(STORAGE_KEYS.stashKey, toBase64(stashKeyBytes));
        if (device?.id) {
            localStorage.setItem(STORAGE_KEYS.deviceId, device.id);
        }


        await authenticate(stashId, stashKeyBytes);
        closeModal();
        enterStash();
    } catch (err) {
        const errorEl = document.getElementById("modal-error");
        if (errorEl) errorEl.textContent = err.message || "Could not connect device.";
    }
}

async function recoveryByPhrase(phrase) {
    try {
        const phraseBytes = await phraseToBytes(phrase);
        const recoveryId = await deriveRecoveryId(phraseBytes);

        const recovery = await apiGetRecoveryByRecoveryId(recoveryId);
        if (!recovery?.stashId || !recovery?.salt || !recovery?.iv || !recovery?.encryptedKey) {
            throw new Error("Invalid recovery data");
        }

        const wrappingKey = await deriveWrappingKey(phrase, fromBase64(recovery.salt));
        const stashKey = await unwrapStashKey(recovery.encryptedKey, recovery.iv, wrappingKey);
        const stashKeyBytes = await exportKeyBytes(stashKey);

        const { deviceType, deviceName } = getDeviceInfo();
        const { device } = await apiCreateRecoveryDevice(recoveryId, deviceName, deviceType);

        localStorage.setItem(STORAGE_KEYS.stashId, recovery.stashId);
        localStorage.setItem(STORAGE_KEYS.stashKey, toBase64(stashKeyBytes));
        localStorage.setItem(STORAGE_KEYS.deviceId, device.id);

        await authenticate(recovery.stashId, stashKeyBytes);
        enterStash();
    } catch (err) {
        document.getElementById("modal-error").textContent =
            err.message || "Recovery failed - check your phrase.";
    }
}

function showJoinModal() {
    openModal(`
        <div class="modal-title">Join a stash</div>
        <div class="modal-sub">Enter the access code shown on your other device.</div>
        <input id="code-input" style="
            width:100%; background:rgba(139,126,200,0.07);
            border:1px solid rgba(139,126,200,0.2); border-radius:0.65rem;
            padding:0.75rem 1rem; color:var(--text-primary);
            font-family:inherit; font-size:1rem; outline:none;
            margin-bottom:1rem; letter-spacing:0.1em; text-transform:uppercase;
        " placeholder="ex: A3F9C2" maxlength="6" autocomplete="off" spellcheck="false" />
        <button class="modal-btn primary" id="join-btn">Connect with code</button>
        <div style="display:flex;align-items:center;gap:0.75rem;margin:0.75rem 0;color:#555565;font-size:0.82rem;">
            <div style="flex:1;height:1px;background:rgba(139,126,200,0.15)"></div>or
            <div style="flex:1;height:1px;background:rgba(139,126,200,0.15)"></div>
        </div>
        <button class="modal-btn" id="recover-btn" style="margin-top:0.6rem;">Recover with phrase</button>
        <div id="modal-error" style="font-size:0.85rem;color:#e06c6c;margin-top:0.5rem;text-align:center"></div>
    `);

    document.getElementById("join-btn").onclick = () => {
        const code = document.getElementById("code-input").value.trim();
        if (code.length < 6) {
            document.getElementById("modal-error").textContent = "Enter the full 6-character code.";
            return;
        }

        const { deviceType, deviceName } = getDeviceInfo();
        joinByCode(code, { deviceName, deviceType });
    };

    document.getElementById("code-input").addEventListener("keydown", e => {
        if (e.key === "Enter") document.getElementById("join-btn").click();
    });

    document.getElementById("recover-btn").onclick = () => {
        openModal(`
            <div class="modal-title">Recover stash</div>
            <div class="modal-sub">Paste your recovery phrase below.</div>
            <textarea id="phrase-input" style="
                width:100%; background:rgba(139,126,200,0.07);
                border:1px solid rgba(139,126,200,0.2); border-radius:0.65rem;
                padding:0.75rem 1rem; color:var(--text-primary);
                font-family:inherit; font-size:0.92rem; outline:none;
                margin-bottom:1rem; resize:none; height:90px; line-height:1.6;
            " placeholder="Paste your recovery phrase here..."></textarea>
            <button class="modal-btn primary" id="recover-confirm-btn">Recover stash</button>
            <div id="modal-error" style="font-size:0.85rem;color:#e06c6c;margin-top:0.5rem;text-align:center"></div>
        `);

        document.getElementById("recover-confirm-btn").onclick = () => {
            const phrase = document.getElementById("phrase-input").value.trim();
            if (!phrase) return;
            recoveryByPhrase(phrase);
        };
    };
}

async function tryAutoLogin() {
    const stashId = localStorage.getItem(STORAGE_KEYS.stashId);
    const stashKeyB64 = localStorage.getItem(STORAGE_KEYS.stashKey);
    if (!stashId || !stashKeyB64) return;

    try {
        const stashKeyBytes = fromBase64(stashKeyB64);
        await authenticate(stashId, stashKeyBytes);
        enterStash();
    } catch { }
}

const enterStash = () => window.location.href = "/vault";

function getDeviceInfo() {
    const ua = navigator.userAgent || "";
    const isTouch = navigator.maxTouchPoints > 0;
    const isMobileUA = /iPhone|Android.+Mobile|Mobile/i.test(ua);
    const isIpad = /iPad/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

    let type = "desktop";

    if (isIpad) {
        type = "tablet";
    } else if (isMobileUA) {
        type = "mobile";
    } else if (isTouch && window.innerWidth < 900) {
        type = "mobile";
    } else if (isTouch) {
        type = "tablet";
    }

    return {
        deviceType: type,
        deviceName: type === "mobile" ? "Phone" : type === "tablet" ? "Tablet" : "Desktop"
    };
}

document.addEventListener("DOMContentLoaded", async () => {
    const params = new URLSearchParams(window.location.search);
    const join = params.get("join");
    const secret = params.get("secret");

    if (join) {
        const { deviceType, deviceName } = getDeviceInfo();

        openModal(`
            <div class="modal-title">Connecting device</div>
            <div class="modal-sub">Securely signing you in...</div>
            <div id="modal-error" style="font-size:0.85rem;color:#e06c6c;margin-top:0.75rem;text-align:center"></div>
        `);

        await joinByCode(join, {
            secret,
            deviceName,
            deviceType,
        });

        history.replaceState({}, "", window.location.pathname);
        return;
    }

    tryAutoLogin();
});

createBtn.addEventListener("click", e => {
    e.preventDefault();
    createStash();
});

joinBtn.addEventListener("click", e => {
    e.preventDefault();
    showJoinModal();
});