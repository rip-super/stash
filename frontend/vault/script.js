const vaultData = { id: "root", name: "stash", type: "folder", children: [], modified: "" };

const deviceData = [
    { id: "dev-1", name: "MacBook Pro", type: "desktop", lastSeen: "Last seen just now" },
    { id: "dev-2", name: "iPhone 15", type: "mobile", lastSeen: "Last seen 1 min ago" },
    { id: "dev-3", name: "Work Laptop", type: "desktop", lastSeen: "Last seen 18 min ago" },
    { id: "dev-4", name: "iPad Air", type: "tablet", lastSeen: "Last seen yesterday" },
];

const state = {
    path: [],
    history: [[]],
    historyIndex: 0,
    selectedItemId: null,
    dragActive: false,
    draggedItemId: null,
    folderDropTargetId: null,
    parentDropActive: false,
    searchQuery: "",
    renamingItemId: null,
    navDirection: null,
    newItemIds: new Set(),
};

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

if (!localStorage.getItem(STORAGE_KEYS.stashKey)) {
    window.location.replace("/");
}

async function saveMetadata() {
    const stashId = localStorage.getItem(STORAGE_KEYS.stashId);
    const stashKeyBytes = fromBase64(localStorage.getItem(STORAGE_KEYS.stashKey));
    const token = localStorage.getItem(STORAGE_KEYS.sessionToken);
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
    if (!state.selectedItemId) return null;
    return findNodeAndParentById(state.selectedItemId)?.node || null;
}

function fuzzyMatch(text, query) {
    const source = (text || "").toLowerCase().trim();
    const needle = (query || "").toLowerCase().trim();

    if (!needle) return true;
    if (source.includes(needle)) return true;

    let i = 0;
    let j = 0;

    while (i < source.length && j < needle.length) {
        if (source[i] === needle[j]) j++;
        i++;
    }

    return j === needle.length;
}

function getVisibleItems(items) {
    if (!state.searchQuery) return items;

    const results = [];
    const currentFolder = getCurrentFolder();

    function walk(node, trail = []) {
        for (const child of node.children || []) {
            const nextTrail = [...trail, child.name];

            if (fuzzyMatch(child.name, state.searchQuery)) {
                results.push({
                    ...child,
                    searchPath: nextTrail.slice(0, -1).join(" / ")
                });
            }

            if (child.type === "folder") {
                walk(child, nextTrail);
            }
        }
    }

    walk(currentFolder);
    return results;
}

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
    if (type === "mobile") {
        return `
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="8" y="2.75" width="8" height="18.5" rx="2.2"></rect>
            <path d="M11 18.25h2"></path>
          </svg>
        `;
    }

    if (type === "tablet") {
        return `
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="6" y="3" width="12" height="18" rx="2"></rect>
            <path d="M11 18.5h2"></path>
          </svg>
        `;
    }

    if (type === "server") {
        return `
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="4" y="4" width="16" height="6" rx="1.5"></rect>
            <rect x="4" y="14" width="16" height="6" rx="1.5"></rect>
            <path d="M8 7h.01M8 17h.01"></path>
          </svg>
        `;
    }

    return `
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="5" width="18" height="12" rx="2"></rect>
          <path d="M8 19h8"></path>
        </svg>
      `;
}

function setDropActive(active) {
    if (state.draggedItemId) return;
    state.dragActive = active;
    dropzoneEl.classList.toggle("drag-active", active);
    dropOverlayEl.setAttribute("aria-hidden", active ? "false" : "true");
}

function setDragMoveMode(active) {
    dragParentDockEl.classList.toggle("hidden", !active || state.path.length === 0);
}

function clearSelection() {
    state.selectedItemId = null;
}

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
        button.addEventListener("click", () => {
            navigateToCrumb(Number(button.dataset.crumbIndex));
        });
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
        ...visibleItems.filter(i => i.type === "folder"),
        ...visibleItems.filter(i => i.type === "file")
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
                ${state.selectedItemId === item.id ? "selected" : ""}
                ${state.draggedItemId === item.id ? "dragging" : ""}
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
            <div class="meta-cell subtle">${item.type === "folder" ? "-" : item.size}</div>
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

        row.addEventListener("click", () => {
            if (state.renamingItemId === id) return;
            state.selectedItemId = id;

            listBodyEl.querySelectorAll(".list-row").forEach(listRow => {
                listRow.classList.toggle("selected", listRow.dataset.id === id);
            });

            renderSelection();
        });

        row.addEventListener("dblclick", () => {
            if (state.renamingItemId) return;
            if (type === "folder") openFolder(id);
        });

        row.addEventListener("dragstart", event => {
            if (state.renamingItemId) { event.preventDefault(); return; }
            state.draggedItemId = id;
            state.folderDropTargetId = null;
            state.parentDropActive = false;
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", id);

            const ghost = document.createElement("div");
            ghost.className = "drag-ghost";
            ghost.innerHTML = `${itemIcon(type)}<span>${row.querySelector(".row-name")?.textContent || ""}</span>`;
            document.body.appendChild(ghost);
            event.dataTransfer.setDragImage(ghost, 20, 20);
            requestAnimationFrame(() => ghost.remove());

            setDragMoveMode(true);
            requestAnimationFrame(async () => await renderList());
        });

        row.addEventListener("dragend", async () => {
            state.draggedItemId = null;
            state.folderDropTargetId = null;
            state.parentDropActive = false;
            setDragMoveMode(false);
            parentDropzoneEl.classList.remove("active");
            await renderList();
        });

        if (type === "folder") {
            row.addEventListener("dragover", event => {
                if (!state.draggedItemId || state.draggedItemId === id) return;
                if (!canMoveItem(state.draggedItemId, id)) return;
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
                await moveItemToFolder(state.draggedItemId, id);
            });
        }
    });
}

function renderSelection() {
    const item = getSelectedItem();

    if (!item) {
        if (selectionPanelEl.classList.contains("hidden")) return;

        selectionPanelEl.classList.remove("open");
        selectionPanelEl.classList.add("closing");

        selectionPanelEl.addEventListener("animationend", () => {
            selectionPanelEl.classList.add("hidden");
            selectionPanelEl.classList.remove("closing");
        }, { once: true });

        return;
    }

    selectionLabelEl.textContent = item.type === "folder" ? "selected folder" : "selected file";
    selectionNameEl.textContent = item.name;
    selectionMetaEl.innerHTML = item.type === "folder"
        ? `
            <span>folder</span>
            <span class="bullet">&#9679;</span>
            <span>${item.modified}</span>
        `
        : `
            <span>${item.size}</span>
            <span class="bullet">&#9679;</span>
            <span>${item.modified}</span>
        `;

    selectionPanelEl.classList.remove("hidden", "closing");
    selectionPanelEl.classList.add("open");
}

function renderDevices() {
    deviceListEl.innerHTML = deviceData.map(device => `
        <div class="device-row" data-id="${device.id}">
            <div class="device-icon" aria-hidden="true">
                ${deviceIcon(device.type)}
            </div>
            <div class="device-info">
                <div class="device-name-row">
                    <h3 class="device-name">${device.name}</h3>
                    <button type="button" class="remove-device-btn" data-id="${device.id}" aria-label="Remove ${device.name}">&#10005;</button>
                </div>
                <div class="device-meta">
                    <span>${device.lastSeen}</span>
                </div>
            </div>
        </div>
    `).join("");

    deviceListEl.querySelectorAll(".remove-device-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const row = btn.closest(".device-row");
            const id = btn.dataset.id;

            row.classList.add("exiting");

            row.addEventListener("transitionend", event => {
                if (event.target !== row) return;

                const idx = deviceData.findIndex(d => d.id === id);
                if (idx !== -1) {
                    deviceData.splice(idx, 1);
                }

                row.remove();

                if (deviceSummaryEl) {
                    deviceSummaryEl.textContent = `${deviceData.length} device${deviceData.length === 1 ? "" : "s"} connected`;
                }
            }, { once: true });
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

async function upload(files) {
    const stashId = localStorage.getItem(STORAGE_KEYS.stashId);
    const stashKeyBytes = fromBase64(localStorage.getItem(STORAGE_KEYS.stashKey));
    const token = localStorage.getItem(STORAGE_KEYS.sessionToken);
    const currentFolder = getCurrentFolder();
    const now = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

    for (const file of Array.from(files)) {
        const fileBytes = await file.arrayBuffer();
        const encrypted = await encryptBlob(fileBytes, stashKeyBytes);
        const { blobId } = await apiUploadBlob(stashId, token, encrypted);

        const kb = Math.max(1, Math.round(file.size / 1024));
        const newItem = {
            id: "file-" + Date.now(),
            name: file.name,
            type: "file",
            size: kb >= 1024 ? (kb / 1024).toFixed(1) + " MB" : kb + " KB",
            modified: now,
            blobId
        };

        currentFolder.children.unshift(newItem);
        state.newItemIds.add(newItem.id);
    }

    const buffer = await encryptMetadata(vaultData, stashKeyBytes);
    await apiPutMetadata(stashId, token, buffer);

    clearSelection();
    setDropActive(false);
    await render();
}

async function addFolder() {
    const currentFolder = getCurrentFolder();
    const count = currentFolder.children.filter(
        item => item.type === "folder" && item.name.startsWith("new folder")
    ).length + 1;
    const now = new Date().toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric"
    });

    const newFolder = {
        id: "folder-" + Date.now(),
        name: count === 1 ? "new folder" : `new folder ${count}`,
        type: "folder",
        modified: now,
        children: []
    };

    currentFolder.children.unshift(newFolder);
    state.selectedItemId = newFolder.id;
    state.newItemIds.add(newFolder.id);
    state.renamingItemId = newFolder.id;
    await render();
}

async function deleteSelected() {
    const selected = getSelectedItem();
    if (!selected || selected.id === "root") return;

    const stashId = localStorage.getItem(STORAGE_KEYS.stashId);
    const stashKeyBytes = fromBase64(localStorage.getItem(STORAGE_KEYS.stashKey));
    const token = localStorage.getItem(STORAGE_KEYS.sessionToken);

    function collectBlobIds(node) {
        const ids = [];
        if (node.blobId) ids.push(node.blobId);
        for (const child of node.children || []) ids.push(...collectBlobIds(child));
        return ids;
    }

    const blobIds = collectBlobIds(selected);
    await Promise.all(blobIds.map(blobId =>
        fetch(`/stash/${stashId}/blob/${blobId}`, {
            method: "DELETE",
            headers: { "Authorization": `Bearer ${token}` }
        })
    ));

    const rowEl = listBodyEl.querySelector(`[data-id="${selected.id}"]`);
    if (rowEl) {
        rowEl.classList.add("exiting");
        rowEl.addEventListener("animationend", async () => {
            const found = findNodeAndParentById(selected.id);
            if (found?.parent?.children) {
                found.parent.children = found.parent.children.filter(i => i.id !== selected.id);
            }
            clearSelection();
            const buffer = await encryptMetadata(vaultData, stashKeyBytes);
            await apiPutMetadata(stashId, token, buffer);
            await render();
        }, { once: true });
    } else {
        const found = findNodeAndParentById(selected.id);
        if (found?.parent?.children) {
            found.parent.children = found.parent.children.filter(i => i.id !== selected.id);
        }
        clearSelection();
        const buffer = await encryptMetadata(vaultData, stashKeyBytes);
        await apiPutMetadata(stashId, token, buffer);
        await render();
    }
}

async function startInlineRename() {
    const selected = getSelectedItem();
    if (!selected || selected.id === "root") return;

    state.renamingItemId = selected.id;
    await renderList();
}

async function downloadSelected() {
    const selected = getSelectedItem();
    if (!selected) return;

    const stashId = localStorage.getItem(STORAGE_KEYS.stashId);
    const stashKeyBytes = fromBase64(localStorage.getItem(STORAGE_KEYS.stashKey));
    const token = localStorage.getItem(STORAGE_KEYS.sessionToken);

    if (selected.type === "file") {
        const buffer = await apiDownloadBlob(stashId, token, selected.blobId);
        const decrypted = await decryptBlob(buffer, stashKeyBytes);
        const url = URL.createObjectURL(new Blob([decrypted]));
        const a = document.createElement("a");

        a.href = url;
        a.download = selected.name;
        a.click();
        URL.revokeObjectURL(url);

        return;
    }

    const toast = document.createElement("div");
    toast.className = "download-toast";
    toast.textContent = "Downloading! Thank you for using stash!";
    document.body.appendChild(toast);

    const zip = new window.JSZip();

    async function addToZip(node, folder) {
        for (const child of node.children || []) {
            if (child.type === "file") {
                const buffer = await apiDownloadBlob(stashId, token, child.blobId);
                const decrypted = await decryptBlob(buffer, stashKeyBytes);
                folder.file(child.name, decrypted);
            } else if (child.type === "folder") {
                const subfolder = folder.folder(child.name);
                await addToZip(child, subfolder);
            }
        }
    }

    await addToZip(selected, zip.folder(selected.name));

    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");

    a.href = url;
    a.download = `${selected.name}.zip`;
    a.click();
    URL.revokeObjectURL(url);

    toast.classList.add("hiding");
    toast.addEventListener("animationend", () => toast.remove(), { once: true });
}

function isDescendantFolder(sourceId, targetFolderId) {
    const sourceFound = findNodeAndParentById(sourceId);
    if (!sourceFound || sourceFound.node.type !== "folder") return false;

    function walk(node) {
        if (!node.children) return false;

        for (const child of node.children) {
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

async function moveItemToFolder(sourceId, targetFolderId) {
    if (!canMoveItem(sourceId, targetFolderId)) {
        state.draggedItemId = null;
        setDragMoveMode(false);
        await render();
        return;
    }

    const sf = findNodeAndParentById(sourceId);
    const tf = findNodeAndParentById(targetFolderId);

    if (!sf?.parent?.children || !tf?.node?.children) return;

    const item = sf.node;
    sf.parent.children = sf.parent.children.filter(i => i.id !== sourceId);
    tf.node.children.unshift(item);

    state.draggedItemId = null;
    state.folderDropTargetId = null;

    setDragMoveMode(false);
    await saveMetadata();
    await render();
}

async function moveItemToParentFolder(sourceId) {
    if (!sourceId || state.path.length === 0) return;

    const sourceFound = findNodeAndParentById(sourceId);
    if (!sourceFound?.parent) return;

    const currentFolderId = state.path[state.path.length - 1];
    if (sourceFound.parent.id !== currentFolderId) return;

    let targetParent = vaultData;

    if (state.path.length > 1) {
        const parentFolderId = state.path[state.path.length - 2];
        const found = findNodeAndParentById(parentFolderId);
        if (!found?.node || found.node.type !== "folder") return;
        targetParent = found.node;
    }

    if (targetParent.id === sourceId) return;
    if (isDescendantFolder(sourceId, targetParent.id)) return;

    const movingItem = sourceFound.node;
    sourceFound.parent.children = sourceFound.parent.children.filter(item => item.id !== sourceId);
    targetParent.children.unshift(movingItem);

    state.draggedItemId = null;
    state.folderDropTargetId = null;
    state.parentDropActive = false;
    parentDropzoneEl.classList.remove("active");

    setDragMoveMode(false);
    await saveMetadata();
    await render();
}

document.getElementById("uploadBtn").addEventListener("click", () => fileInputEl.click());
document.getElementById("emptyUploadBtn")?.addEventListener("click", () => fileInputEl.click());
document.getElementById("newFolderBtn").addEventListener("click", addFolder);
document.getElementById("deleteBtn").addEventListener("click", deleteSelected);
document.getElementById("renameBtn").addEventListener("click", startInlineRename);
document.getElementById("downloadBtn").addEventListener("click", downloadSelected);

closeSelectionBtnEl.addEventListener("click", () => {
    clearSelection();

    listBodyEl.querySelectorAll(".list-row").forEach(row => {
        row.classList.remove("selected");
    });

    renderSelection();
});

backBtnEl.addEventListener("click", goBack);
forwardBtnEl.addEventListener("click", goForward);

fileInputEl.addEventListener("change", event => {
    if (event.target.files?.length) {
        upload(event.target.files);
    }
    fileInputEl.value = "";
});

document.addEventListener("dragover", event => {
    if (state.draggedItemId) {
        event.preventDefault();
        return;
    }

    event.preventDefault();
    setDropActive(true);
});

document.addEventListener("dragenter", event => {
    if (state.draggedItemId) return;
    event.preventDefault();
    setDropActive(true);
});

document.addEventListener("dragleave", event => {
    if (state.draggedItemId) return;

    if (
        !event.relatedTarget ||
        event.clientX <= 0 ||
        event.clientY <= 0 ||
        event.clientX >= window.innerWidth ||
        event.clientY >= window.innerHeight
    ) {
        setDropActive(false);
    }
});

document.addEventListener("drop", event => {
    if (state.draggedItemId) return;

    event.preventDefault();
    setDropActive(false);

    const files = event.dataTransfer?.files;
    if (files?.length) {
        upload(files);
    }
});

parentDropzoneEl.addEventListener("dragover", event => {
    if (!state.draggedItemId || state.path.length === 0) return;
    event.preventDefault();
    state.parentDropActive = true;
    parentDropzoneEl.classList.add("active");
});

parentDropzoneEl.addEventListener("dragleave", () => {
    state.parentDropActive = false;
    parentDropzoneEl.classList.remove("active");
});

parentDropzoneEl.addEventListener("drop", async event => {
    event.preventDefault();
    parentDropzoneEl.classList.remove("active");
    await moveItemToParentFolder(state.draggedItemId);
});

window.addEventListener("blur", async () => {
    setDropActive(false);

    if (!state.draggedItemId) return;

    state.folderDropTargetId = null;
    state.parentDropActive = false;
    parentDropzoneEl.classList.remove("active");
    setDragMoveMode(false);
    await renderList();
});

document.addEventListener("mouseleave", () => {
    if (!state.draggedItemId) {
        setDropActive(false);
    }
});

vaultSearchEl.addEventListener("input", async event => {
    state.searchQuery = event.target.value;
    clearSelection();
    await renderList();
});

document.addEventListener("keydown", async event => {
    if (event.key === "Escape" && state.renamingItemId) {
        state.renamingItemId = null;
        await renderList();
    }

    if (event.key === "F2" && state.selectedItemId && !state.renamingItemId) {
        await startInlineRename();
    }
});

(async () => {
    const stashId = localStorage.getItem(STORAGE_KEYS.stashId);
    const stashKey = localStorage.getItem(STORAGE_KEYS.stashKey);

    if (!stashId || !stashKey) { window.location.replace("/"); return; }

    const stashKeyBytes = fromBase64(stashKey);

    try {
        const token = await authenticate(stashId, stashKeyBytes);
        const buffer = await apiGetMetadata(stashId, token);
        if (buffer) {
            const loaded = await decryptMetadata(buffer, stashKeyBytes);
            Object.assign(vaultData, loaded);
        }
    } catch (err) {
        localStorage.removeItem(STORAGE_KEYS.stashId);
        localStorage.removeItem(STORAGE_KEYS.stashKey);
        localStorage.removeItem(STORAGE_KEYS.sessionToken);
        window.location.replace("/");
        return;
    }

    renderDevices();
    await render();
})();