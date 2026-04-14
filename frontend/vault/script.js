// #region Constants

const vaultData = { id: "root", name: "stash", type: "folder", children: [], modified: "" };
const deviceData = [];

const state = {
    path: [],
    history: [[]],
    historyIndex: 0,
    selectedItemIds: [],
    lastSelectedItemId: null,
    dragActive: false,
    draggedItemIds: [],
    folderDropTargetId: null,
    parentDropActive: false,
    searchQuery: "",
    renamingItemId: null,
    navDirection: null,
    newItemIds: new Set(),
    pendingDeviceDeleteId: null,
    renamingDeviceId: null,
    currentAccessCode: "",
    previewObjectUrl: null,
    previewRequestToken: 0,
    fileCache: new Map(),
    fileCacheBytes: 0,
};

const FILE_CACHE_MAX_BYTES = 300 * 1024 * 1024;

// #endregion

// #region DOM vars

const breadcrumbsEl = document.getElementById("breadcrumbs");
const listBodyEl = document.getElementById("listBody");
const emptyStateEl = document.getElementById("emptyState");
const listStateEl = document.getElementById("listState");
const selectionPanelEl = document.getElementById("selectionPanel");
const selectionLabelEl = document.getElementById("selectionLabel");
const selectionNameEl = document.getElementById("selectionName");
const selectionMetaEl = document.getElementById("selectionMeta");
const vaultSearchEl = document.getElementById("vaultSearch");
const dropzoneEl = document.getElementById("dropzone");
const dropOverlayEl = document.getElementById("dropOverlay");
const fileInputEl = document.getElementById("fileInput");
const deviceListEl = document.getElementById("deviceList");
const deviceSummaryEl = document.getElementById("deviceSummary");
const backBtnEl = document.getElementById("backBtn");
const forwardBtnEl = document.getElementById("forwardBtn");
const closeSelectionBtnEl = document.getElementById("closeSelectionBtn");
const dragParentDockEl = document.getElementById("dragParentDock");
const parentDropzoneEl = document.getElementById("parentDropzone");
const addDeviceBtnEl = document.getElementById("addDeviceBtn");
const deviceConnectModalEl = document.getElementById("deviceConnectModal");
const deviceDeleteModalEl = document.getElementById("deviceDeleteModal");
const deviceQrCodeEl = document.getElementById("deviceQrCode");
const deviceAccessCodeEl = document.getElementById("deviceAccessCode");
const deviceAccessExpiryEl = document.getElementById("deviceAccessExpiry");
const confirmRemoveDeviceBtnEl = document.getElementById("confirmRemoveDeviceBtn");
const deviceDeleteCopyEl = document.getElementById("deviceDeleteCopy");
const deleteStashModalEl = document.getElementById("deleteStashModal");
const deleteStashBtnEl = document.getElementById("deleteStashBtn");
const confirmDeleteStashBtnEl = document.getElementById("confirmDeleteStashBtn");
const selectionPreviewEl = document.getElementById("selectionPreview");
const sendViaFilesBtnEl = document.getElementById("sendViaFilesBtn");

// #endregion

// #region Helpers

function getStashContext() {
    return {
        stashId: localStorage.getItem(STORAGE_KEYS.stashId),
        stashKeyBytes: fromBase64(localStorage.getItem(STORAGE_KEYS.stashKey)),
        token: localStorage.getItem(STORAGE_KEYS.sessionToken),
        deviceId: localStorage.getItem(STORAGE_KEYS.deviceId),
    };
}

async function saveMetadata() {
    const { stashId, stashKeyBytes, token } = getStashContext();
    const buffer = await encryptMetadata(vaultData, stashKeyBytes);
    await apiPutMetadata(stashId, token, buffer);
}

function getCurrentFolder() {
    let node = vaultData;

    for (const id of state.path) {
        const next = (node.children || []).find(child => child.id === id && child.type === "folder");
        if (!next) break;
        node = next;
    }

    return node;
}

function findNodeAndParentById(id, node = vaultData, parent = null) {
    if (node.id === id) return { node, parent };
    if (!node.children) return null;

    for (const child of node.children) {
        const found = findNodeAndParentById(id, child, node);
        if (found) return found;
    }

    return null;
}

function getSelectedItem() {
    if (state.selectedItemIds.length !== 1) return null;
    return findNodeAndParentById(state.selectedItemIds[0])?.node || null;
}

function fuzzyMatch(text, query) {
    const source = (text || "").toLowerCase().trim();
    const needle = (query || "").toLowerCase().trim();

    if (!needle) return true;
    if (source.includes(needle)) return true;

    let i = 0, j = 0;
    while (i < source.length && j < needle.length) {
        if (source[i] === needle[j]) j++;
        i++;
    }

    return j === needle.length;
}

function getVisibleItems(items) {
    if (!state.searchQuery) return items;

    const results = [];

    function walk(node, trail = []) {
        for (const child of node.children || []) {
            const nextTrail = [...trail, child.name];

            if (fuzzyMatch(child.name, state.searchQuery)) {
                results.push({ ...child, searchPath: nextTrail.slice(0, -1).join(" / ") });
            }

            if (child.type === "folder") walk(child, nextTrail);
        }
    }

    walk(getCurrentFolder());
    return results;
}

function showToast(message) {
    const toast = document.createElement("div");
    toast.className = "download-toast";
    toast.textContent = message;
    document.body.appendChild(toast);

    return {
        update(msg) { toast.textContent = msg; },
        hide() {
            toast.classList.add("hiding");
            toast.addEventListener("animationend", () => toast.remove(), { once: true });
        }
    };
}

function updateRowProgress(itemId, text) {
    const row = listBodyEl.querySelector(`.list-row[data-id="${itemId}"]`);
    if (!row) return;

    const pct = text.match(/(\d+)%/)?.[1];

    let bar = row.querySelector(".upload-progress-bar");
    if (!bar) {
        bar = document.createElement("div");
        bar.className = "upload-progress-bar";
        bar.style.cssText = `
            position: absolute;
            bottom: 0; left: 0;
            height: 2px;
            background: currentColor;
            opacity: 0.35;
            transition: width 0.2s ease;
            pointer-events: none;
        `;
        row.style.position = "relative";
        row.style.overflow = "hidden";
        row.appendChild(bar);
    }

    bar.style.width = pct ? `${pct}%` : "100%";
}

function getUniqueChildName(folder, name) {
    const children = folder.children || [];
    const existingNames = new Set(children.map(child => child.name));

    if (!existingNames.has(name)) return name;

    const dotIndex = name.lastIndexOf(".");
    const hasExtension = dotIndex > 0;
    const base = hasExtension ? name.slice(0, dotIndex) : name;
    const ext = hasExtension ? name.slice(dotIndex) : "";

    let i = 1;
    let nextName = `${base} (${i})${ext}`;

    while (existingNames.has(nextName)) {
        i++;
        nextName = `${base} (${i})${ext}`;
    }

    return nextName;
}

async function loadDevices() {
    const { stashId, token } = getStashContext();
    const { devices, currentDeviceId } = await apiListDevices(stashId, token);
    deviceData.splice(0, deviceData.length, ...(devices || []));
    if (currentDeviceId) {
        localStorage.setItem(STORAGE_KEYS.deviceId, currentDeviceId);
    }
}

let deviceRefreshTimer = null;

function startDeviceRefresh() {
    stopDeviceRefresh();
    deviceRefreshTimer = setInterval(async () => {
        try {
            await loadDevices();
            renderDevices();
        } catch (error) {
            console.error("Failed to refresh devices:", error);
        }
    }, 2000);
}

function stopDeviceRefresh() {
    if (deviceRefreshTimer) {
        clearInterval(deviceRefreshTimer);
        deviceRefreshTimer = null;
    }
}

function openModal(modal) {
    if (!modal) return;
    modal.classList.remove("hidden", "closing");
    modal.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => {
        modal.classList.remove("closing");
    });
}

function closeModal(modal) {
    if (!modal || modal.classList.contains("hidden") || modal.classList.contains("closing")) return;

    modal.classList.add("closing");
    modal.setAttribute("aria-hidden", "true");

    const finish = () => {
        modal.classList.add("hidden");
        modal.classList.remove("closing");
    };

    modal.addEventListener("transitionend", finish, { once: true });
}

function getSelectedItems() {
    return state.selectedItemIds
        .map(id => findNodeAndParentById(id)?.node)
        .filter(Boolean);
}

function clearSelection() {
    state.selectedItemIds = [];
    state.lastSelectedItemId = null;
}

function clearSelectionPreview() {
    state.previewRequestToken++;
    state.previewObjectUrl = null;

    if (selectionPreviewEl) {
        selectionPreviewEl.innerHTML = "";
        selectionPreviewEl.classList.add("hidden");
    }
}

function escapeHtml(value = "") {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function removeCachedBlob(blobId) {
    const cached = state.fileCache.get(blobId);
    if (!cached) return;

    if (cached.objectUrl) {
        URL.revokeObjectURL(cached.objectUrl);
    }

    state.fileCache.delete(blobId);
    state.fileCacheBytes -= cached.size || 0;

    if (state.fileCacheBytes < 0) {
        state.fileCacheBytes = 0;
    }
}

function trimFileCache() {
    if (state.fileCacheBytes <= FILE_CACHE_MAX_BYTES) return;

    const entries = [...state.fileCache.entries()]
        .filter(([, entry]) => !entry.pending)
        .sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);

    for (const [blobId] of entries) {
        if (state.fileCacheBytes <= FILE_CACHE_MAX_BYTES) break;
        removeCachedBlob(blobId);
    }
}

async function getCachedDecryptedBlob(item, {
    onDownloadProgress = null,
    onDecryptProgress = null,
    allowAbort = false,
    isStillWanted = null,
} = {}) {
    if (!item?.blobId) {
        throw new Error("Missing blobId");
    }

    let cached = state.fileCache.get(item.blobId);

    if (cached?.buffer) {
        cached.lastAccessed = Date.now();
        return cached;
    }

    if (!cached) {
        cached = {
            buffer: null,
            size: 0,
            objectUrl: null,
            lastAccessed: Date.now(),
            pending: null,
        };

        state.fileCache.set(item.blobId, cached);
    }

    if (!cached.pending) {
        cached.pending = (async () => {
            const { stashId, stashKeyBytes, token } = getStashContext();

            const encrypted = await apiDownloadBlob(
                stashId,
                token,
                item.blobId,
                onDownloadProgress || undefined
            );

            if (allowAbort && isStillWanted && !isStillWanted()) {
                return null;
            }

            const decrypted = await decryptBlob(
                encrypted,
                stashKeyBytes,
                onDecryptProgress || undefined
            );

            if (allowAbort && isStillWanted && !isStillWanted()) {
                return null;
            }

            cached.buffer = decrypted;
            cached.size = decrypted.byteLength;
            cached.lastAccessed = Date.now();
            cached.pending = null;

            state.fileCacheBytes += cached.size;
            trimFileCache();

            return cached;
        })().catch(error => {
            removeCachedBlob(item.blobId);
            throw error;
        });
    }

    const resolved = await cached.pending;

    if (!resolved) {
        removeCachedBlob(item.blobId);
        return null;
    }

    cached.lastAccessed = Date.now();
    return cached;
}

// #endregion

// #region Icons

function itemIcon(type) {
    if (type === "folder") {
        return `
          <span class="row-icon folder-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M3.5 7.5a2 2 0 0 1 2-2h4l1.6 1.8h7.4a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>
            </svg>
          </span>
        `;
    }

    return `
        <span class="row-icon file-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M8 3.5h5.5L18.5 8v12a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6.5 20v-15A1.5 1.5 0 0 1 8 3.5z"/>
            <path d="M13.5 3.5V8H18.5"/>
          </svg>
        </span>
      `;
}

function deviceIcon(type) {
    if (type === "mobile") return `
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="8" y="2.75" width="8" height="18.5" rx="2.2"></rect>
          <path d="M11 18.25h2"></path>
        </svg>
    `;

    if (type === "tablet") return `
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="6" y="3" width="12" height="18" rx="2"></rect>
          <path d="M11 18.5h2"></path>
        </svg>
    `;

    if (type === "server") return `
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="4" y="4" width="16" height="6" rx="1.5"></rect>
          <rect x="4" y="14" width="16" height="6" rx="1.5"></rect>
          <path d="M8 7h.01M8 17h.01"></path>
        </svg>
    `;

    return `
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="5" width="18" height="12" rx="2"></rect>
          <path d="M8 19h8"></path>
        </svg>
      `;
}

// #endregion

// #region Navigation

function pushHistory(nextPath) {
    const normalized = [...nextPath];
    const current = state.history[state.historyIndex] || [];

    if (JSON.stringify(current) === JSON.stringify(normalized)) {
        state.path = normalized;
        return;
    }

    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push(normalized);
    state.historyIndex = state.history.length - 1;
    state.path = normalized;
}

async function goBack() {
    if (state.historyIndex === 0) return;
    state.historyIndex--;
    state.path = [...state.history[state.historyIndex]];
    state.navDirection = "back";
    clearSelection();
    await render();
}

async function goForward() {
    if (state.historyIndex >= state.history.length - 1) return;
    state.historyIndex++;
    state.path = [...state.history[state.historyIndex]];
    state.navDirection = "forward";
    clearSelection();
    await render();
}

async function openFolder(folderId) {
    pushHistory([...state.path, folderId]);
    state.navDirection = "forward";
    clearSelection();
    await render();
}

async function navigateToCrumb(index) {
    const targetPath = index === 0 ? [] : state.path.slice(0, index);
    state.navDirection = targetPath.length < state.path.length ? "back" : "forward";
    pushHistory(targetPath);
    clearSelection();
    await render();
}

// #endregion

// #region Rendering

function renderBreadcrumbs() {
    const trail = [{ id: "root", name: "Home", root: true }];
    let node = vaultData;

    for (const id of state.path) {
        const next = (node.children || []).find(child => child.id === id && child.type === "folder");

        if (!next) break;
        trail.push({ id: next.id, name: next.name });

        node = next;
    }

    breadcrumbsEl.innerHTML = trail.map((crumb, index) => {
        const isLast = index === trail.length - 1;

        return `
          <button
            type="button"
            class="crumb ${isLast ? "current" : ""}"
            data-crumb-index="${index}"
            ${isLast ? 'aria-current="page"' : ""}
          >
            ${crumb.name}
          </button>
          ${isLast ? "" : '<span class="crumb-sep">/</span>'}
        `;
    }).join("");

    breadcrumbsEl.querySelectorAll(".crumb").forEach(button => {
        button.addEventListener("click", () => navigateToCrumb(Number(button.dataset.crumbIndex)));
    });
}

async function renderList() {
    const currentFolder = getCurrentFolder();
    const visibleItems = getVisibleItems(currentFolder.children || []);

    if (!visibleItems.length) {
        emptyStateEl.classList.remove("hidden");
        listStateEl.classList.add("hidden");

        if (state.searchQuery.trim()) {
            emptyStateEl.innerHTML = `
                <div class="empty-icon">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"></circle><path d="M16 16l4 4"></path></svg>
                </div>
                <h2>No matches found.</h2>
                <p>Try a different search term or clear the search to see everything in this folder.</p>
                <button type="button" class="action" id="clearSearchBtn">clear search</button>
            `;
            document.getElementById("clearSearchBtn")?.addEventListener("click", async () => {
                state.searchQuery = "";
                vaultSearchEl.value = "";
                await renderList();
            });
        } else {
            emptyStateEl.innerHTML = `
                <div class="empty-icon">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v10m0 0 4-4m-4 4-4-4M5 18h14" /></svg>
                </div>
                <h2>Nothing here yet.</h2>
                <p>Drop some files here to get started with stash!</p>
                <button type="button" class="action" id="emptyUploadBtn">upload to vault</button>
            `;
            document.getElementById("emptyUploadBtn")?.addEventListener("click", () => fileInputEl.click());
        }

        state.navDirection = null;
        return;
    }

    emptyStateEl.classList.add("hidden");
    listStateEl.classList.remove("hidden");

    const ordered = [
        ...visibleItems.filter(i => i.type === "folder").sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })),
        ...visibleItems.filter(i => i.type === "file").sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }))
    ];

    listBodyEl.innerHTML = ordered.map((item, index) => {
        const isRenaming = item.id === state.renamingItemId;
        const isNew = state.newItemIds.has(item.id);

        const nameContent = isRenaming
            ? `<input type="text" class="rename-input" id="rename-input-${item.id}"
                 value="${item.name.replace(/"/g, "&quot;")}"
                 autocomplete="off" spellcheck="false" />`
            : `<div class="row-copy">
                <span class="row-name">${item.name}</span>
                ${item.searchPath ? `<span class="row-path">${item.searchPath}</span>` : ""}
               </div>`;

        return `<button
            type="button"
            class="list-row
                ${state.selectedItemIds.includes(item.id) ? "selected" : ""}
                ${state.draggedItemIds.includes(item.id) ? "dragging" : ""}
                ${state.folderDropTargetId === item.id ? "drop-target" : ""}
                ${isRenaming ? "renaming" : ""}
                ${isNew ? "new-item" : ""}"
            data-id="${item.id}"
            data-type="${item.type}"
            draggable="${isRenaming ? "false" : "true"}"
            style="--row-index: ${index}"
        >
            <div class="name-cell">
                ${itemIcon(item.type)}
                ${nameContent}
            </div>
            <div class="meta-cell subtle">${item.type === "folder" ? "-" : item.pending ? "uploading..." : item.error ? "failed" : item.size}</div>
            <div class="meta-cell subtle">${item.modified}</div>
        </button>`;
    }).join("");

    state.newItemIds.clear();

    if (state.navDirection) {
        listBodyEl.classList.remove("enter-forward", "enter-back");
        void listBodyEl.offsetWidth;
        listBodyEl.classList.add(state.navDirection === "forward" ? "enter-forward" : "enter-back");
        listBodyEl.addEventListener("animationend", () => {
            listBodyEl.classList.remove("enter-forward", "enter-back");
        }, { once: true });

        state.navDirection = null;
    }

    if (state.renamingItemId) {
        const input = document.getElementById(`rename-input-${state.renamingItemId}`);

        if (input) {
            requestAnimationFrame(() => { input.focus(); input.select(); });
            let committed = false;

            const commit = async () => {
                if (committed) return;
                committed = true;
                const found = findNodeAndParentById(state.renamingItemId);
                if (found?.node) {
                    const name = input.value.trim();
                    if (name) {
                        found.node.name = name;
                        await saveMetadata();
                    }
                }
                state.renamingItemId = null;
                await render();
            };

            const cancel = async () => {
                if (committed) return;
                committed = true;
                state.renamingItemId = null;
                await render();
            };

            input.addEventListener("keydown", e => {
                if (e.key === "Enter") { e.preventDefault(); commit(); }
                if (e.key === "Escape") { e.preventDefault(); cancel(); }
            });
            input.addEventListener("blur", commit);
            input.addEventListener("click", e => e.stopPropagation());
            input.addEventListener("dblclick", e => e.stopPropagation());
        }
    }

    listBodyEl.querySelectorAll(".list-row").forEach(row => {
        const { id, type } = row.dataset;

        row.addEventListener("click", event => {
            if (state.renamingItemId === id) return;

            const visibleRows = Array.from(listBodyEl.querySelectorAll(".list-row"));
            const visibleIds = visibleRows.map(entry => entry.dataset.id);

            if (event.shiftKey && state.lastSelectedItemId && visibleIds.includes(state.lastSelectedItemId)) {
                const start = visibleIds.indexOf(state.lastSelectedItemId);
                const end = visibleIds.indexOf(id);
                const [from, to] = start < end ? [start, end] : [end, start];
                state.selectedItemIds = visibleIds.slice(from, to + 1);
            } else if (event.metaKey || event.ctrlKey) {
                if (state.selectedItemIds.includes(id)) {
                    state.selectedItemIds = state.selectedItemIds.filter(selectedId => selectedId !== id);
                    state.lastSelectedItemId = state.selectedItemIds[state.selectedItemIds.length - 1] || null;
                } else {
                    state.selectedItemIds = [...state.selectedItemIds, id];
                    state.lastSelectedItemId = id;
                }
            } else {
                state.selectedItemIds = [id];
                state.lastSelectedItemId = id;
            }

            listBodyEl.querySelectorAll(".list-row").forEach(r => {
                r.classList.toggle("selected", state.selectedItemIds.includes(r.dataset.id));
            });

            renderSelection();
        });

        row.addEventListener("dblclick", () => {
            if (state.renamingItemId) return;
            if (type === "folder") openFolder(id);
        });

        row.addEventListener("dragstart", event => {
            if (state.renamingItemId) {
                event.preventDefault();
                return;
            }

            if (!state.selectedItemIds.includes(id)) {
                state.selectedItemIds = [id];
                state.lastSelectedItemId = id;
                listBodyEl.querySelectorAll(".list-row").forEach(r => {
                    r.classList.toggle("selected", r.dataset.id === id);
                });
                renderSelection();
            }

            state.draggedItemIds = [...state.selectedItemIds];
            state.folderDropTargetId = null;
            state.parentDropActive = false;

            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", state.draggedItemIds.join(","));

            const ghost = document.createElement("div");
            ghost.className = "drag-ghost";

            if (state.draggedItemIds.length === 1) {
                ghost.innerHTML = `${itemIcon(type)}<span>${row.querySelector(".row-name")?.textContent || ""}</span>`;
            } else {
                ghost.innerHTML = `${itemIcon("folder")}<span>${state.draggedItemIds.length} items</span>`;
            }

            document.body.appendChild(ghost);
            event.dataTransfer.setDragImage(ghost, 20, 20);
            requestAnimationFrame(() => ghost.remove());

            setDragMoveMode(true);
            requestAnimationFrame(async () => await renderList());
        });

        row.addEventListener("dragend", async () => {
            state.draggedItemIds = [];
            state.folderDropTargetId = null;
            state.parentDropActive = false;
            setDragMoveMode(false);
            parentDropzoneEl.classList.remove("active");
            await renderList();
        });

        if (type === "folder") {
            row.addEventListener("dragover", event => {
                if (!state.draggedItemIds.length) return;
                if (state.draggedItemIds.includes(id)) return;

                let canMove = false;

                for (const draggedId of state.draggedItemIds) {
                    if (!canMoveItem(draggedId, id)) {
                        canMove = false;
                        break;
                    }
                    canMove = true;
                }

                if (!canMove) return;

                event.preventDefault();
                state.folderDropTargetId = id;
                row.classList.add("drop-target");
            });

            row.addEventListener("dragleave", () => {
                if (state.folderDropTargetId === id) {
                    state.folderDropTargetId = null;
                    row.classList.remove("drop-target");
                }
            });

            row.addEventListener("drop", async event => {
                event.preventDefault();
                row.classList.remove("drop-target");
                state.folderDropTargetId = null;
                await moveItemToFolder(id);
            });
        }
    });
}

function renderSelection() {
    const selectedItems = getSelectedItems();
    const renameBtn = document.getElementById("renameBtn");

    if (!selectedItems.length) {
        clearSelectionPreview();

        if (selectionPanelEl.classList.contains("hidden") || selectionPanelEl.classList.contains("closing")) {
            renameBtn.disabled = true;
            renameBtn.setAttribute("aria-disabled", "true");
            return;
        }

        selectionPanelEl.classList.remove("open");
        selectionPanelEl.classList.add("closing");
        selectionPanelEl.addEventListener("animationend", () => {
            selectionPanelEl.classList.add("hidden");
            selectionPanelEl.classList.remove("closing");
        }, { once: true });

        renameBtn.disabled = true;
        renameBtn.setAttribute("aria-disabled", "true");
        return;
    }

    selectionPanelEl.classList.remove("hidden", "closing");
    requestAnimationFrame(() => selectionPanelEl.classList.add("open"));

    if (selectedItems.length > 1) {
        const fileCount = selectedItems.filter(item => item.type === "file").length;
        const folderCount = selectedItems.filter(item => item.type === "folder").length;

        selectionLabelEl.textContent = "selected items";

        if (fileCount && folderCount) {
            selectionNameEl.textContent = `${selectedItems.length} items`;
        } else if (fileCount) {
            selectionNameEl.textContent = `${fileCount} file${fileCount === 1 ? "" : "s"}`;
        } else {
            selectionNameEl.textContent = `${folderCount} folder${folderCount === 1 ? "" : "s"}`;
        }

        selectionMetaEl.innerHTML = `
            <span class="subtle">
                ${fileCount} file${fileCount === 1 ? "" : "s"} • ${folderCount} folder${folderCount === 1 ? "" : "s"}
            </span>
        `;

        renameBtn.disabled = true;
        renameBtn.setAttribute("aria-disabled", "true");
        clearSelectionPreview();
        return;
    }

    const item = selectedItems[0];

    selectionLabelEl.textContent = item.type === "folder" ? "selected folder" : "selected file";
    selectionNameEl.textContent = item.name;
    selectionMetaEl.innerHTML = item.type === "folder"
        ? `<span class="subtle">${item.children?.length || 0} item${(item.children?.length || 0) === 1 ? "" : "s"}</span>`
        : `<span class="subtle">${item.size || "-"} • ${item.modified || "Unknown date"}</span>`;

    renameBtn.disabled = false;
    renameBtn.setAttribute("aria-disabled", "false");

    if (item.type !== "file" || item.pending || item.error || !item.blobId) {
        clearSelectionPreview();
        return;
    }

    const mime = (item.mimeType || "").toLowerCase();
    const dotIndex = item.name.lastIndexOf(".");
    const ext = dotIndex > -1 ? item.name.slice(dotIndex + 1).toLowerCase() : "";

    let previewKind = null;
    const CODE_EXTS = new Set([
        "txt", "md", "js", "ts", "jsx", "tsx", "json", "json5",
        "css", "scss", "html", "xml", "yml", "yaml", "log",
        "py", "sh", "bash", "env", "toml", "ini", "cfg"
    ]);

    if (mime.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext)) {
        previewKind = "image";
    } else if (mime.startsWith("video/") || ["mp4", "webm", "mov", "m4v", "ogv"].includes(ext)) {
        previewKind = "video";
    } else if (mime.startsWith("audio/") || ["mp3", "wav", "ogg", "m4a", "flac", "aac"].includes(ext)) {
        previewKind = "audio";
    } else if (mime === "application/pdf" || ext === "pdf") {
        previewKind = "pdf";
    } else if (mime.startsWith("text/") || CODE_EXTS.has(ext)) {
        previewKind = "text";
    }

    if (!previewKind) {
        clearSelectionPreview();
        return;
    }

    const PREVIEW_SIZE_LIMIT = 20 * 1024 * 1024;
    const fileSize = item.rawSize || 0;

    clearSelectionPreview();
    selectionPreviewEl.classList.remove("hidden");

    if (fileSize > PREVIEW_SIZE_LIMIT) {
        selectionPreviewEl.innerHTML = `
            <div class="selection-preview-inner">
                <div class="selection-preview-empty">
                    <button type="button" id="forcePreviewBtn" style="
                        background: none;
                        border: none;
                        color: inherit;
                        font: inherit;
                        font-size: 0.8rem;
                        cursor: pointer;
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        gap: 5px;
                        padding: 0;
                    ">
                        <span>this is a large file...</span>
                        <span>load preview?</span>
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                            <circle cx="12" cy="12" r="3"/>
                        </svg>
                    </button>
                </div>
            </div>
        `;

        document.getElementById("forcePreviewBtn")?.addEventListener("click", () => {
            loadPreview(item, previewKind);
        });

        return;
    }

    loadPreview(item, previewKind);
}

function loadPreview(item, previewKind) {
    clearSelectionPreview();
    selectionPreviewEl.classList.remove("hidden");
    selectionPreviewEl.innerHTML = `
        <div class="selection-preview-inner">
            <div class="selection-preview-empty" id="previewStatus">Preparing preview...</div>
        </div>
    `;

    const requestToken = ++state.previewRequestToken;

    const setStatus = msg => {
        if (requestToken !== state.previewRequestToken) return;
        const el = document.getElementById("previewStatus");
        if (el) el.textContent = msg;
    };

    (async () => {
        try {
            const cached = await getCachedDecryptedBlob(item, {
                onDownloadProgress: p => setStatus(`Downloading ${Math.round(p * 100)}%`),
                onDecryptProgress: p => setStatus(`Decrypting ${Math.round(p * 100)}%`),
                allowAbort: true,
                isStillWanted: () => requestToken === state.previewRequestToken,
            });

            if (!cached || requestToken !== state.previewRequestToken) return;

            if (previewKind === "text") {
                selectionPreviewEl.innerHTML = `
                    <div class="selection-preview-inner">
                        <pre>${escapeHtml(new TextDecoder().decode(cached.buffer.slice(0, 64 * 1024)))}</pre>
                    </div>
                `;
                return;
            }

            if (!cached.objectUrl) {
                const mimeMap = {
                    image: item.mimeType || "image/*",
                    video: item.mimeType || "video/mp4",
                    audio: item.mimeType || "audio/*",
                    pdf: "application/pdf",
                };

                cached.objectUrl = URL.createObjectURL(
                    new Blob([cached.buffer], { type: mimeMap[previewKind] || "" })
                );
            }

            state.previewObjectUrl = cached.objectUrl;

            const tagMap = {
                image: `<img src="${cached.objectUrl}" alt="${escapeHtml(item.name)} preview" loading="lazy" />`,
                video: `<video src="${cached.objectUrl}" controls muted preload="metadata" playsinline></video>`,
                audio: `<audio src="${cached.objectUrl}" controls preload="metadata"></audio>`,
                pdf: `<iframe src="${cached.objectUrl}" title="${escapeHtml(item.name)} preview"></iframe>`,
            };

            selectionPreviewEl.innerHTML = `<div class="selection-preview-inner">${tagMap[previewKind]}</div>`;
        } catch (error) {
            if (requestToken !== state.previewRequestToken) return;
            console.error("Preview failed:", error);
            selectionPreviewEl.innerHTML = `
                <div class="selection-preview-inner">
                    <div class="selection-preview-empty">Preview unavailable.</div>
                </div>
            `;
        }
    })();
}

function renderDevices() {
    const { deviceId: currentDeviceId } = getStashContext();

    deviceListEl.innerHTML = deviceData.map(device => {
        const isCurrentDevice = device.id === currentDeviceId;

        return `
        <div class="device-row ${isCurrentDevice ? "is-current-device" : ""}" data-id="${device.id}">
            <div class="device-icon" aria-hidden="true">${deviceIcon(device.type)}</div>
            <div class="device-info">
                <div class="device-name-row">
                    ${state.renamingDeviceId === device.id
                ? `<input
                                type="text"
                                class="device-inline-input"
                                id="device-rename-input-${device.id}"
                                value="${device.name.replace(/"/g, "&quot;")}"
                                autocomplete="off"
                                spellcheck="false"
                           />`
                : `<h3 class="device-name">${device.name}${isCurrentDevice ? `<span class="device-self-pill">This device</span>` : ""}</h3>`
            }

                    <div class="device-row-actions">
                        <button type="button" class="device-icon-btn rename-device-btn" data-id="${device.id}" aria-label="Rename ${device.name}">
                            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                                <path d="M4 20h4l10-10-4-4L4 16v4zM13 7l4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
                            </svg>
                        </button>
                        ${isCurrentDevice ? "" : `
                        <button type="button" class="remove-device-btn" data-id="${device.id}" aria-label="Remove ${device.name}">
                            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                                <path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>
                            </svg>
                        </button>
                        `}
                    </div>
                </div>

                <div class="device-meta">
                    <span>${device.lastSeenLabel || device.lastSeen || "Last seen recently"}</span>
                </div>
            </div>
        </div>
    `;
    }).join("");

    deviceListEl.querySelectorAll(".rename-device-btn").forEach(btn => {
        btn.addEventListener("click", async event => {
            event.stopPropagation();
            state.renamingDeviceId = btn.dataset.id;
            renderDevices();

            const input = document.getElementById(`device-rename-input-${btn.dataset.id}`);
            if (!input) return;

            requestAnimationFrame(() => {
                input.focus();
                input.select();
            });

            let committed = false;

            const commit = async () => {
                if (committed) return;
                committed = true;

                const name = input.value.trim();
                const device = deviceData.find(entry => entry.id === btn.dataset.id);

                if (name && device && name !== device.name) {
                    const previousName = device.name;
                    device.name = name;
                    renderDevices();

                    try {
                        const { stashId, token } = getStashContext();
                        await apiRenameDevice(stashId, token, btn.dataset.id, name);
                    } catch (error) {
                        device.name = previousName;
                        console.error("Failed to rename device:", error);
                        const toast = showToast("Could not rename device.");
                        setTimeout(() => toast.hide(), 1800);
                    }
                }

                state.renamingDeviceId = null;
                renderDevices();
            };

            const cancel = () => {
                if (committed) return;
                committed = true;
                state.renamingDeviceId = null;
                renderDevices();
            };

            input.addEventListener("keydown", e => {
                if (e.key === "Enter") { e.preventDefault(); commit(); }
                if (e.key === "Escape") { e.preventDefault(); cancel(); }
            });
            input.addEventListener("blur", commit);
            input.addEventListener("click", e => e.stopPropagation());
            input.addEventListener("dblclick", e => e.stopPropagation());
        });
    });

    deviceListEl.querySelectorAll(".remove-device-btn").forEach(btn => {
        btn.addEventListener("click", event => {
            event.stopPropagation();

            state.pendingDeviceDeleteId = btn.dataset.id;

            const device = deviceData.find(entry => entry.id === btn.dataset.id);
            deviceDeleteCopyEl.textContent = device
                ? `"${device.name}" will lose access until it is connected again.`
                : "This device will lose access until it is connected again.";

            openModal(deviceDeleteModalEl);
        });
    });

    if (deviceSummaryEl) {
        deviceSummaryEl.textContent = `${deviceData.length} device${deviceData.length === 1 ? "" : "s"} connected`;
    }
}

async function render() {
    backBtnEl.disabled = state.historyIndex === 0;
    forwardBtnEl.disabled = state.historyIndex >= state.history.length - 1;
    renderBreadcrumbs();
    await renderList();
    renderSelection();
}

async function loadAndRenderQuota() {
    const { stashId, token } = getStashContext();
    const quotaFillEl = document.getElementById("quotaFill");
    const quotaValueEl = document.getElementById("quotaValue");

    try {
        const { used, limit } = await apiGetQuota(stashId, token);
        const pct = Math.min((used / limit) * 100, 100);
        const usedMB = (used / 1024 / 1024).toFixed(1);
        const limitMB = Math.round(limit / 1024 / 1024);

        quotaFillEl.style.width = pct + "%";
        quotaFillEl.classList.toggle("warn", pct >= 70 && pct < 90);
        quotaFillEl.classList.toggle("crit", pct >= 90);
        quotaValueEl.textContent = `${usedMB} / ${limitMB} MB`;
    } catch {
        quotaValueEl.textContent = "unavailable";
    }
}

// #endregion

// #region File I/O

async function uploadOneFile(file, folder) {
    const { stashId, stashKeyBytes, token } = getStashContext();
    const now = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

    const newItem = {
        id: "file-" + crypto.randomUUID(),
        name: getUniqueChildName(folder, file.name),
        type: "file", size: "...", modified: now,
        blobId: null, mimeType: file.type || "", pending: true, rawSize: file.size,
    };

    folder.children.unshift(newItem);
    state.newItemIds.add(newItem.id);

    await renderList();

    try {
        const chunkCount = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
        const totalServerChunks = chunkCount + 1;
        let doneChunks = 0;

        const { blobId } = await apiStartBlobUpload(stashId, token);
        const CONCURRENCY = 5;
        const inFlight = [];

        await encryptBlob(await file.arrayBuffer(), stashKeyBytes, null, async (index, buffer) => {
            inFlight.push(
                apiUploadChunk(stashId, token, blobId, index, buffer).then(() => {
                    doneChunks++;
                    updateRowProgress(newItem.id, `uploading ${Math.round((doneChunks / totalServerChunks) * 100)}%`);
                })
            );
            if (inFlight.length > CONCURRENCY) await inFlight.shift();
        });

        await Promise.all(inFlight);
        const { blobId: confirmedId } = await apiCompleteBlobUpload(stashId, token, blobId, totalServerChunks);

        const kb = Math.max(1, Math.round(file.size / 1024));
        newItem.blobId = confirmedId;
        newItem.size = kb >= 1024 ? (kb / 1024).toFixed(1) + " MB" : kb + " KB";
        newItem.pending = false;
        await saveMetadata();
        await loadAndRenderQuota();
    } catch (err) {
        newItem.pending = false;
        newItem.error = true;
        const toast = showToast(`Upload failed: ${err.message}`);
        setTimeout(() => toast.hide(), 3500);
    }

    await renderList();
}

async function upload(files, targetFolder = getCurrentFolder()) {
    const toast = showToast("Uploading files! This might take a while...");

    try {
        for (const file of Array.from(files)) {
            await uploadOneFile(file, targetFolder);
        }

        await saveMetadata();
        clearSelection();
        setDropActive(false);
        await render();
    } finally {
        await loadAndRenderQuota();
        toast.hide();
    }
}

async function addFolder() {
    const currentFolder = getCurrentFolder();
    const newFolder = {
        id: "folder-" + Date.now(),
        name: getUniqueChildName(currentFolder, "new folder"),
        type: "folder",
        modified: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
        children: []
    };

    currentFolder.children.unshift(newFolder);
    state.selectedItemIds = [newFolder.id];
    state.lastSelectedItemId = newFolder.id;
    state.newItemIds.add(newFolder.id);
    state.renamingItemId = newFolder.id;
    await render();
}

async function deleteSelected() {
    const selectedItems = getSelectedItems().filter(item => item.id !== "root");
    if (!selectedItems.length) return;

    const { stashId, token } = getStashContext();
    const currentFolder = getCurrentFolder();
    const idsToDelete = new Set(selectedItems.map(item => item.id));
    const originalChildren = [...(currentFolder.children || [])];

    const rowsToDelete = Array.from(listBodyEl.querySelectorAll(".list-row"))
        .filter(row => idsToDelete.has(row.dataset.id));

    if (rowsToDelete.length) {
        await Promise.all(rowsToDelete.map(row => new Promise(resolve => {
            let done = false;

            const finish = () => {
                if (done) return;
                done = true;
                resolve();
            };

            row.classList.add("exiting");
            row.addEventListener("transitionend", finish, { once: true });
            row.addEventListener("animationend", finish, { once: true });
            setTimeout(finish, 400);
        })));
    }

    const removed = [];
    currentFolder.children = originalChildren.filter(item => {
        if (idsToDelete.has(item.id)) {
            removed.push(item);
            return false;
        }
        return true;
    });

    clearSelection();
    await render();

    try {
        const blobIds = [];

        for (const item of removed) {
            const stack = [item];

            while (stack.length) {
                const node = stack.pop();

                if (node.type === "file" && node.blobId) {
                    blobIds.push(node.blobId);
                }

                if (node.type === "folder" && node.children?.length) {
                    for (const child of node.children) {
                        stack.push(child);
                    }
                }
            }
        }

        for (const blobId of blobIds) {
            removeCachedBlob(blobId);
        }

        if (blobIds.length) {
            await apiFetch(`/stash/${stashId}/blobs`, {
                method: "DELETE",
                token,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ blobIds })
            });
        }

        await saveMetadata();
    } catch (error) {
        console.error("Delete failed:", error);
        currentFolder.children = originalChildren;

        for (const item of removed) {
            state.newItemIds.add(item.id);
        }

        await render();

        const toast = showToast("Deleting failed. Try again later.");
        setTimeout(() => toast.hide(), 2200);
    } finally {
        await loadAndRenderQuota();
    }
}

async function startInlineRename() {
    const selectedItems = getSelectedItems();
    if (selectedItems.length !== 1) return;
    if (selectedItems[0].id === "root") return;

    state.renamingItemId = selectedItems[0].id;
    await renderList();
}

async function downloadSelected() {
    const selectedItems = getSelectedItems();
    if (!selectedItems.length) return;

    if (selectedItems.length === 1 && selectedItems[0].type === "file") {
        const selected = selectedItems[0];
        const toast = showToast("Downloading...");

        try {
            const cached = await getCachedDecryptedBlob(selected, {
                onDownloadProgress: p => toast.update(`Downloading ${Math.round(p * 100)}%`),
                onDecryptProgress: p => toast.update(`Decrypting ${Math.round(p * 100)}%`),
            });

            const url = URL.createObjectURL(
                new Blob([cached.buffer], { type: selected.mimeType || "application/octet-stream" })
            );

            const a = document.createElement("a");
            a.href = url;
            a.download = selected.name;
            a.click();

            setTimeout(() => URL.revokeObjectURL(url), 0);
        } finally {
            toast.hide();
        }

        return;
    }

    const toast = showToast("Preparing download...");
    const zip = new window.JSZip();
    const allFiles = [];

    try {
        for (const selected of selectedItems) {
            if (selected.type === "file") {
                allFiles.push({ node: selected, zipFolder: zip });
                continue;
            }

            const isSingleFolder = selectedItems.length === 1;
            const stack = [{ node: selected, folder: isSingleFolder ? zip : zip.folder(selected.name) }];

            while (stack.length) {
                const { node, folder } = stack.pop();

                for (const child of node.children || []) {
                    if (child.type === "file") {
                        allFiles.push({ node: child, zipFolder: folder });
                    } else {
                        stack.push({ node: child, folder: folder.folder(child.name) });
                    }
                }
            }
        }

        for (let i = 0; i < allFiles.length; i++) {
            const { node, zipFolder } = allFiles[i];
            toast.update(`Downloading ${i + 1}/${allFiles.length}: ${node.name}`);

            const cached = await getCachedDecryptedBlob(node);
            zipFolder.file(node.name, cached.buffer.slice(0));
        }

        toast.update("Compressing...");
        const blob = await zip.generateAsync({ type: "blob" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");

        a.href = url;
        a.download = selectedItems.length === 1 && selectedItems[0].type === "folder"
            ? `${selectedItems[0].name}.zip`
            : "selection.zip";
        a.click();

        setTimeout(() => URL.revokeObjectURL(url), 0);
    } finally {
        toast.hide();
    }
}

async function sendViaFiles() {
    const selected = getSelectedItem();
    if (!selected) return;

    const toast = showToast("Preparing files...");
    const filesToSend = [];

    try {
        const allFiles = [];

        if (selected.type === "file") {
            allFiles.push(selected);
        } else {
            const stack = [selected];
            while (stack.length) {
                const node = stack.pop();
                for (const child of node.children || []) {
                    if (child.type === "file") allFiles.push(child);
                    else stack.push(child);
                }
            }
        }

        for (let i = 0; i < allFiles.length; i++) {
            const file = allFiles[i];
            const label = allFiles.length > 1 ? ` (${i + 1}/${allFiles.length})` : "";

            const cached = await getCachedDecryptedBlob(file, {
                onDownloadProgress: p => toast.update(`Downloading${label} ${Math.round(p * 100)}%`),
                onDecryptProgress: p => toast.update(`Decrypting${label} ${Math.round(p * 100)}%`),
            });

            filesToSend.push({
                name: file.name,
                type: file.mimeType || "",
                buffer: cached.buffer.slice(0),
            });
        }

        toast.hide();

        const filesWin = window.open("https://files.sahildash.dev", "_blank");
        if (!filesWin) {
            const t = showToast("Popup blocked - allow popups and try again.");
            setTimeout(() => t.hide(), 3000);
            return;
        }

        let pingInterval = null;
        let pingTimeout = null;

        const onReady = (event) => {
            if (event.origin !== "https://files.sahildash.dev") return;
            if (event.data?.type !== "stash:ready") return;

            clearInterval(pingInterval);
            clearTimeout(pingTimeout);
            window.removeEventListener("message", onReady);

            filesWin.postMessage(
                { type: "stash:files", files: filesToSend },
                "https://files.sahildash.dev",
                filesToSend.map(f => f.buffer)
            );
        };

        window.addEventListener("message", onReady);

        pingInterval = setInterval(() => {
            try {
                filesWin.postMessage({ type: "stash:ping" }, "https://files.sahildash.dev");
            } catch { }
        }, 300);

        pingTimeout = setTimeout(() => {
            clearInterval(pingInterval);
            window.removeEventListener("message", onReady);
            const t = showToast("Could not reach files.sahildash.dev.");
            setTimeout(() => t.hide(), 2500);
        }, 15000);

    } catch (err) {
        toast.hide();
        const t = showToast("Failed to prepare files.");
        setTimeout(() => t.hide(), 2500);
    }
}

// #endregion

// #region Drag and Drop

function setDropActive(active) {
    if (state.draggedItemIds.length) return;
    state.dragActive = active;
    dropzoneEl.classList.toggle("drag-active", active);
    dropOverlayEl.setAttribute("aria-hidden", active ? "false" : "true");
}

function setDragMoveMode(active) {
    dragParentDockEl.classList.toggle("hidden", !active || state.path.length === 0);
}

function isDescendantFolder(sourceId, targetFolderId) {
    const sourceFound = findNodeAndParentById(sourceId);
    if (!sourceFound || sourceFound.node.type !== "folder") return false;

    function walk(node) {
        for (const child of node.children || []) {
            if (child.id === targetFolderId) return true;
            if (child.type === "folder" && walk(child)) return true;
        }

        return false;
    }

    return walk(sourceFound.node);
}

function canMoveItem(sourceId, targetFolderId) {
    if (!sourceId || !targetFolderId || sourceId === targetFolderId) return false;

    const sf = findNodeAndParentById(sourceId);
    const tf = findNodeAndParentById(targetFolderId);

    if (!sf || !tf || tf.node.type !== "folder") return false;
    if (isDescendantFolder(sourceId, targetFolderId)) return false;
    if (sf.parent && sf.parent.id === targetFolderId) return false;

    return true;
}

async function moveItemToFolder(targetFolderId) {
    if (!state.draggedItemIds.length) {
        setDragMoveMode(false);
        await render();
        return;
    }

    const targetFolder = findNodeAndParentById(targetFolderId)?.node;
    if (!targetFolder || targetFolder.type !== "folder") {
        state.draggedItemIds = [];
        setDragMoveMode(false);
        await render();
        return;
    }

    const draggedItems = state.draggedItemIds
        .map(id => findNodeAndParentById(id))
        .filter(Boolean)
        .sort((a, b) => {
            const aIndex = a.parent?.children?.findIndex(item => item.id === a.node.id) ?? -1;
            const bIndex = b.parent?.children?.findIndex(item => item.id === b.node.id) ?? -1;
            return aIndex - bIndex;
        });

    for (const found of draggedItems) {
        if (!canMoveItem(found.node.id, targetFolderId)) {
            const toast = showToast("Move failed.");
            setTimeout(() => toast.hide(), 1800);

            state.draggedItemIds = [];
            state.folderDropTargetId = null;
            setDragMoveMode(false);
            await render();
            return;
        }
    }

    const existingNames = new Set((targetFolder.children || []).map(item => item.name));
    const incomingNames = new Set();

    for (const found of draggedItems) {
        if (existingNames.has(found.node.name) || incomingNames.has(found.node.name)) {
            const toast = showToast("Move failed. A file or folder with that name already exists.");
            setTimeout(() => toast.hide(), 2200);

            state.draggedItemIds = [];
            state.folderDropTargetId = null;
            setDragMoveMode(false);
            await render();
            return;
        }

        incomingNames.add(found.node.name);
    }

    const movedNodes = [];

    for (const found of draggedItems) {
        found.parent.children = found.parent.children.filter(item => item.id !== found.node.id);
        movedNodes.push(found.node);
    }

    targetFolder.children.unshift(...movedNodes);

    state.draggedItemIds = [];
    state.folderDropTargetId = null;

    setDragMoveMode(false);
    await saveMetadata();
    await render();
}

async function moveItemToParentFolder() {
    if (!state.draggedItemIds.length || state.path.length === 0) return;

    let targetParent = vaultData;

    if (state.path.length > 1) {
        const parentFolderId = state.path[state.path.length - 2];
        const found = findNodeAndParentById(parentFolderId);
        if (!found?.node || found.node.type !== "folder") return;
        targetParent = found.node;
    }

    const currentFolderId = state.path[state.path.length - 1];

    const draggedItems = state.draggedItemIds
        .map(id => findNodeAndParentById(id))
        .filter(found => found?.parent?.id === currentFolderId)
        .sort((a, b) => {
            const aIndex = a.parent?.children?.findIndex(item => item.id === a.node.id) ?? -1;
            const bIndex = b.parent?.children?.findIndex(item => item.id === b.node.id) ?? -1;
            return aIndex - bIndex;
        });

    for (const found of draggedItems) {
        if (targetParent.id === found.node.id || isDescendantFolder(found.node.id, targetParent.id)) {
            const toast = showToast("Move failed.");
            setTimeout(() => toast.hide(), 1800);

            state.draggedItemIds = [];
            state.folderDropTargetId = null;
            state.parentDropActive = false;
            parentDropzoneEl.classList.remove("active");
            setDragMoveMode(false);
            await render();
            return;
        }
    }

    const existingNames = new Set((targetParent.children || []).map(item => item.name));
    const incomingNames = new Set();

    for (const found of draggedItems) {
        if (existingNames.has(found.node.name) || incomingNames.has(found.node.name)) {
            const toast = showToast("Move failed. A file or folder with that name already exists.");
            setTimeout(() => toast.hide(), 2200);

            state.draggedItemIds = [];
            state.folderDropTargetId = null;
            state.parentDropActive = false;
            parentDropzoneEl.classList.remove("active");
            setDragMoveMode(false);
            await render();
            return;
        }

        incomingNames.add(found.node.name);
    }

    const movedNodes = [];

    for (const found of draggedItems) {
        found.parent.children = found.parent.children.filter(item => item.id !== found.node.id);
        movedNodes.push(found.node);
    }

    targetParent.children.unshift(...movedNodes);

    state.draggedItemIds = [];
    state.folderDropTargetId = null;
    state.parentDropActive = false;
    parentDropzoneEl.classList.remove("active");

    setDragMoveMode(false);
    await saveMetadata();
    await render();
}

// #endregion

// #region Event Listeners

document.getElementById("uploadBtn").addEventListener("click", () => fileInputEl.click());
document.getElementById("newFolderBtn").addEventListener("click", addFolder);
document.getElementById("deleteBtn").addEventListener("click", deleteSelected);
document.getElementById("renameBtn").addEventListener("click", startInlineRename);
document.getElementById("downloadBtn").addEventListener("click", downloadSelected);

closeSelectionBtnEl.addEventListener("click", () => {
    clearSelectionPreview();
    clearSelection();
    listBodyEl.querySelectorAll(".list-row").forEach(row => row.classList.remove("selected"));
    renderSelection();
});

backBtnEl.addEventListener("click", goBack);
forwardBtnEl.addEventListener("click", goForward);

fileInputEl.addEventListener("change", event => {
    if (event.target.files?.length) upload(event.target.files);
    fileInputEl.value = "";
});

document.addEventListener("dragover", event => {
    event.preventDefault();

    if (state.draggedItemIds.length) return;

    const hasFiles = Array.from(event.dataTransfer?.types || []).includes("Files");
    setDropActive(hasFiles);
});

document.addEventListener("dragenter", event => {
    event.preventDefault();

    if (state.draggedItemIds.length) return;

    const hasFiles = Array.from(event.dataTransfer?.types || []).includes("Files");
    if (hasFiles) setDropActive(true);
});

document.addEventListener("dragleave", event => {
    if (state.draggedItemIds.length) return;

    if (
        !event.relatedTarget ||
        event.clientX <= 0 || event.clientY <= 0 ||
        event.clientX >= window.innerWidth || event.clientY >= window.innerHeight
    ) {
        setDropActive(false);
    }
});

document.addEventListener("drop", async event => {
    if (state.draggedItemIds.length) return;

    event.preventDefault();
    setDropActive(false);

    const items = Array.from(event.dataTransfer?.items || []);
    const entries = items
        .map(item => item.webkitGetAsEntry?.())
        .filter(Boolean);

    if (!entries.length) {
        const files = event.dataTransfer?.files;
        if (files?.length) await upload(files);
        return;
    }

    const toast = showToast("Uploading files! This might take a while...");

    const now = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const rootFolder = getCurrentFolder();

    async function walk(entry, folder) {
        if (entry.isFile) {
            const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
            await uploadOneFile(file, folder);
            return;
        }

        if (!entry.isDirectory) return;

        let childFolder = folder.children.find(
            item => item.type === "folder" && item.name === entry.name
        );

        if (!childFolder) {
            childFolder = {
                id: "folder-" + crypto.randomUUID(),
                name: getUniqueChildName(folder, entry.name),
                type: "folder",
                modified: now,
                children: []
            };

            folder.children.unshift(childFolder);
            state.newItemIds.add(childFolder.id);

            await renderList();
        }

        const reader = entry.createReader();
        const children = [];

        while (true) {
            const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
            if (!batch.length) break;
            children.push(...batch);
        }

        for (const child of children) {
            await walk(child, childFolder);
        }
    }

    try {
        for (const entry of entries) {
            await walk(entry, rootFolder);
        }

        await saveMetadata();
        clearSelection();
        await render();
    } catch (error) {
        console.error("Folder drop failed:", error);
    } finally {
        await loadAndRenderQuota();
        toast.hide();
    }
});

document.addEventListener("mouseleave", () => {
    if (!state.draggedItemIds.length) setDropActive(false);
});

dropzoneEl.addEventListener("click", event => {
    if (event.target.closest(".list-row")) return;
    if (event.target.closest(".selection-card")) return;
    if (event.target.closest(".parent-dropzone")) return;

    clearSelection();
    listBodyEl.querySelectorAll(".list-row").forEach(row => row.classList.remove("selected"));
    renderSelection();
});

listStateEl.addEventListener("click", event => {
    if (event.target.closest(".list-row")) return;

    clearSelection();
    listBodyEl.querySelectorAll(".list-row").forEach(row => row.classList.remove("selected"));
    renderSelection();
});

parentDropzoneEl.addEventListener("dragover", event => {
    if (!state.draggedItemIds.length || state.path.length === 0) return;
    event.preventDefault();
    state.parentDropActive = true;
    parentDropzoneEl.classList.add("active");
});

parentDropzoneEl.addEventListener("dragleave", event => {
    if (!parentDropzoneEl.contains(event.relatedTarget)) {
        state.parentDropActive = false;
        parentDropzoneEl.classList.remove("active");
    }
});

parentDropzoneEl.addEventListener("drop", async event => {
    event.preventDefault();
    state.parentDropActive = false;
    parentDropzoneEl.classList.remove("active");
    await moveItemToParentFolder();
});

window.addEventListener("blur", async () => {
    setDropActive(false);

    if (!state.draggedItemIds.length) return;

    state.draggedItemIds = [];
    state.folderDropTargetId = null;
    state.parentDropActive = false;
    parentDropzoneEl.classList.remove("active");
    setDragMoveMode(false);
    await renderList();
});

vaultSearchEl.addEventListener("input", async event => {
    state.searchQuery = event.target.value;
    clearSelection();
    await renderList();
    renderSelection();
});

document.addEventListener("keydown", async event => {
    if (event.key === "Escape" && state.renamingItemId) {
        state.renamingItemId = null;
        await renderList();
        return;
    }

    if (event.key === "F2" && state.selectedItemIds.length === 1 && !state.renamingItemId) {
        event.preventDefault();
        await startInlineRename();
        return;
    }

    if (event.key === "Delete" && state.selectedItemIds.length && !state.renamingItemId) {
        event.preventDefault();
        await deleteSelected();
    }
});

addDeviceBtnEl?.addEventListener("click", async () => {
    openModal(deviceConnectModalEl);
    startDeviceRefresh();

    state.currentAccessCode = "";
    deviceAccessCodeEl.textContent = "------";
    deviceAccessExpiryEl.textContent = "Generating secure code...";
    deviceQrCodeEl.innerHTML = "";

    try {
        const { stashId, stashKeyBytes, token } = getStashContext();

        const ua = navigator.userAgent || "";
        const deviceType = /iPad|Tablet/i.test(ua) ? "tablet" : /iPhone|Android.+Mobile|Mobile/i.test(ua) ? "mobile" : "desktop";
        const deviceName = deviceType === "mobile" ? "Phone" : deviceType === "tablet" ? "Tablet" : "Desktop";

        const { code, expiresIn } = await apiCreateAccessCode(stashId, token, {
            name: deviceName,
            type: deviceType,
        });

        const salt = crypto.getRandomValues(new Uint8Array(32));
        const wrapKey = await deriveWrappingKey(code, salt);
        const stashKey = await crypto.subtle.importKey("raw", stashKeyBytes, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
        const wrapped = await wrapStashKey(stashKey, wrapKey);
        const transfer = { ...wrapped, salt: toBase64(salt) };

        await apiPutAccessCodeTransfer(stashId, token, code, transfer);

        state.currentAccessCode = code;
        deviceAccessCodeEl.textContent = code;
        deviceAccessExpiryEl.textContent = `Valid for ${Math.floor(expiresIn / 60)} minutes`;

        const joinUrl = `${window.location.origin}/?join=${encodeURIComponent(code)}`;

        deviceQrCodeEl.innerHTML = "";
        const canvas = document.createElement("canvas");
        deviceQrCodeEl.appendChild(canvas);

        await window.QRCode.toCanvas(canvas, joinUrl, {
            width: 220,
            margin: 1,
            errorCorrectionLevel: "M",
        });
    } catch (error) {
        console.error("Failed to generate access code:", error);
        deviceAccessCodeEl.textContent = "ERROR";
        deviceAccessExpiryEl.textContent = "Could not generate code";
        const toast = showToast("Could not generate access code.");
        setTimeout(() => toast.hide(), 2000);
    }
});

document.querySelectorAll("[data-close-modal]").forEach(btn => {
    btn.addEventListener("click", async () => {
        const modal = document.getElementById(btn.dataset.closeModal);
        closeModal(modal);

        if (btn.dataset.closeModal === "deviceConnectModal") {
            stopDeviceRefresh();
            await loadDevices();
            renderDevices();
        }
    });
});

confirmRemoveDeviceBtnEl?.addEventListener("click", async () => {
    if (!state.pendingDeviceDeleteId) return;

    const deviceId = state.pendingDeviceDeleteId;
    const row = deviceListEl.querySelector(`.device-row[data-id="${deviceId}"]`);

    try {
        const { stashId, token } = getStashContext();
        await apiRemoveDevice(stashId, token, deviceId);

        if (row) {
            row.classList.add("exiting");
            row.addEventListener("transitionend", () => {
                const idx = deviceData.findIndex(device => device.id === deviceId);
                if (idx !== -1) deviceData.splice(idx, 1);
                renderDevices();
            }, { once: true });
        } else {
            const idx = deviceData.findIndex(device => device.id === deviceId);
            if (idx !== -1) deviceData.splice(idx, 1);
            renderDevices();
        }

        state.pendingDeviceDeleteId = null;
        closeModal(deviceDeleteModalEl);
    } catch (error) {
        console.error("Failed to remove device:", error);
        const toast = showToast("Could not remove device.");
        setTimeout(() => toast.hide(), 1800);
    }
});

document.getElementById("deleteStashBtn").addEventListener("click", () => {
    openModal(deleteStashModalEl);
});

document.getElementById("confirmDeleteStashBtn").addEventListener("click", async () => {
    const { stashId, token } = getStashContext();
    try {
        await apiFetch(`/stash/${stashId}`, { method: "DELETE", token });
    } catch { }

    localStorage.removeItem(STORAGE_KEYS.stashId);
    localStorage.removeItem(STORAGE_KEYS.stashKey);
    localStorage.removeItem(STORAGE_KEYS.sessionToken);
    localStorage.removeItem(STORAGE_KEYS.deviceId);

    for (const blobId of [...state.fileCache.keys()]) {
        removeCachedBlob(blobId);
    }
    window.location.replace("/");
});

sendViaFilesBtnEl?.addEventListener("click", sendViaFiles);

// #endregion

// #region Init

(async () => {
    const stashId = localStorage.getItem(STORAGE_KEYS.stashId);
    const stashKey = localStorage.getItem(STORAGE_KEYS.stashKey);

    if (!stashId || !stashKey) {
        for (const blobId of [...state.fileCache.keys()]) {
            removeCachedBlob(blobId);
        }

        window.location.replace("/");
        return;
    }

    const stashKeyBytes = fromBase64(stashKey);

    try {
        const token = await authenticate(stashId, stashKeyBytes);
        const buffer = await apiGetMetadata(stashId, token);
        if (buffer) Object.assign(vaultData, await decryptMetadata(buffer, stashKeyBytes));
        await loadDevices();
    } catch {
        localStorage.removeItem(STORAGE_KEYS.stashId);
        localStorage.removeItem(STORAGE_KEYS.stashKey);
        localStorage.removeItem(STORAGE_KEYS.sessionToken);
        localStorage.removeItem(STORAGE_KEYS.deviceId);
        window.location.replace("/");

        return;
    }

    renderDevices();
    await loadAndRenderQuota();
    await render();
})();

// #endregion