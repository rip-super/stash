import { Hono, Context } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFile, writeFile, mkdir, stat, unlink, rm, readdir } from "fs/promises";
import { existsSync, createReadStream, createWriteStream } from "fs";
import { join } from "path";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

interface StashRecord {
    id: string;
    authVerifier: string;
    recoveryId: string,
    quotaUsed: number;
    createdAt: number;
}

interface Registry {
    stashes: Record<string, StashRecord>;
}

interface Device {
    id: string;
    name: string;
    type: "desktop" | "mobile" | "tablet" | "server";
    addedAt: number;
    lastSeenAt: number;
    lastSeenLabel: string;
}

type AccessCode = {
    stashId: string;
    expiresAt: number;
    transfer?: {
        iv: string;
        encryptedKey: string;
        salt: string;
    };
    pendingDevice?: {
        name: string;
        type: "desktop" | "mobile" | "tablet" | "server";
    };
};

const app = new Hono();

const challenges = new Map<string, { nonce: string, expiresAt: number }>();
const sessions = new Map<string, { stashId: string, deviceId: string, expiresAt: number }>();
const accessCodes = new Map<string, AccessCode>();

const QUOTA = 500 * 1024 * 1024;

const STASHES_ROOT = "./stashes";
const REGISTRY_PATH = join(STASHES_ROOT, "registry.json");

const MAX_TOTAL_STORAGE = 50 * 1024 * 1024 * 1024;
const TEMP_UPLOAD_TTL_MS = 60 * 60 * 1000;
const TEMP_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

await mkdir("./stashes", { recursive: true });
if (!existsSync(join("./stashes", "registry.json"))) {
    await writeFile(join("./stashes", "registry.json"), JSON.stringify({ stashes: {} }, null, 4));
}

await cleanupExpiredTempUploads().catch(error => {
    console.error("Initial temp cleanup failed:", error);
});

setInterval(() => {
    cleanupExpiredTempUploads().catch(error => {
        console.error("Temp cleanup failed:", error);
    });
}, TEMP_CLEANUP_INTERVAL_MS);

function getSession(c: Context, id: string) {
    const token = c.req.header("Authorization")?.slice(7);
    const session = sessions.get(token ?? "");
    if (!session) return null;
    if (session.stashId !== id) return null;
    if (Date.now() > session.expiresAt) return null;
    return session;
}

function auth(c: Context, id: string) {
    return !!getSession(c, id);
}

async function getDirectorySize(path: string): Promise<number> {
    const info = await stat(path).catch(() => null);
    if (!info) return 0;
    if (!info.isDirectory()) return info.size;

    let total = 0;
    const entries = await readdir(path, { withFileTypes: true });

    for (const entry of entries) {
        total += await getDirectorySize(join(path, entry.name));
    }

    return total;
}

async function cleanupExpiredTempUploads() {
    if (!existsSync(STASHES_ROOT)) return;

    const stashEntries = await readdir(STASHES_ROOT, { withFileTypes: true });

    for (const stashEntry of stashEntries) {
        if (!stashEntry.isDirectory()) continue;

        const tempRoot = join(STASHES_ROOT, stashEntry.name, "temp");
        if (!existsSync(tempRoot)) continue;

        const uploadEntries = await readdir(tempRoot, { withFileTypes: true });

        for (const uploadEntry of uploadEntries) {
            if (!uploadEntry.isDirectory()) continue;

            const uploadDir = join(tempRoot, uploadEntry.name);
            const sessionPath = join(uploadDir, "session.json");

            let createdAt = 0;

            if (existsSync(sessionPath)) {
                const session = await readFile(sessionPath, "utf-8")
                    .then(text => JSON.parse(text) as { createdAt?: number })
                    .catch(() => null);

                createdAt = session?.createdAt || 0;
            }

            if (!createdAt) {
                const info = await stat(uploadDir).catch(() => null);
                createdAt = info?.mtimeMs || 0;
            }

            if (createdAt && Date.now() - createdAt > TEMP_UPLOAD_TTL_MS) {
                await rm(uploadDir, { recursive: true, force: true });
            }
        }
    }
}

app.post("/stash", async c => {
    const { id, authVerifier, recoveryId, recovery, device } = await c.req.json<{
        id: string,
        authVerifier: string,
        recoveryId: string,
        recovery: { salt: string, kdfParams: object, iv: string, encryptedKey: string },
        device?: {
            name: string,
            type: "desktop" | "mobile" | "tablet" | "server"
        }
    }>();

    if (!id || !authVerifier || !recoveryId || !recovery) return c.json({ error: "Missing required fields" }, 400);

    const reg = JSON.parse(await readFile(join("./stashes", "registry.json"), "utf-8")) as Registry;
    if (reg.stashes[id]) return c.json({ error: "Stash already exists" }, 409);

    await mkdir(join("./stashes", id, "blobs"), { recursive: true });
    await writeFile(join("./stashes", id, "recovery.json"), JSON.stringify(recovery, null, 4));

    reg.stashes[id] = { id, authVerifier, recoveryId, quotaUsed: 0, createdAt: Date.now() };
    await writeFile(join("./stashes", "registry.json"), JSON.stringify(reg, null, 4));

    const firstDevice: Device = {
        id: "dev-" + randomBytes(8).toString("hex"),
        name: device?.name?.trim() || "This device",
        type: device?.type || "desktop",
        addedAt: Date.now(),
        lastSeenAt: Date.now(),
        lastSeenLabel: "Last seen just now",
    };

    await writeFile(join("./stashes", id, "devices.json"), JSON.stringify({ devices: [firstDevice] }, null, 4));

    return c.json({ ok: true, device: firstDevice }, 201);
});

app.delete("/stash/:id", async c => {
    const id = c.req.param("id");
    if (!auth(c, id)) return c.json({ error: "Unauthorized" }, 401);

    const reg = JSON.parse(await readFile(join("./stashes", "registry.json"), "utf-8")) as Registry;
    if (!reg.stashes[id]) return c.json({ error: "Not found" }, 404);

    delete reg.stashes[id];
    await writeFile(join("./stashes", "registry.json"), JSON.stringify(reg, null, 4));

    await rm(join("./stashes", id), { recursive: true, force: true });

    return c.json({ ok: true });
});

app.get("/stash/:id/challenge", async c => {
    const id = c.req.param("id");

    const reg = JSON.parse(await readFile(join("./stashes", "registry.json"), "utf-8")) as Registry;
    if (!reg.stashes[id]) return c.json({ error: "Not found" }, 404);

    const nonce = randomBytes(32).toString("hex");
    challenges.set(id, { nonce, expiresAt: Date.now() + 2 * 60 * 1000 });

    return c.json({ nonce });
});

app.post("/stash/:id/auth", async c => {
    const id = c.req.param("id");

    const reg = JSON.parse(await readFile(join("./stashes", "registry.json"), "utf-8")) as Registry;
    if (!reg.stashes[id]) return c.json({ error: "Not found" }, 404);

    const challenge = challenges.get(id);
    if (!challenge || Date.now() > challenge.expiresAt) {
        challenges.delete(id);
        return c.json({ error: "No active challenge" }, 400);
    }

    const { response, deviceId } = await c.req.json<{ response: string, deviceId?: string }>();
    const expected = createHmac("sha256", Buffer.from(reg.stashes[id].authVerifier, "base64")).update(challenge.nonce).digest("hex");

    if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(response, "hex"))) {
        return c.json({ error: "Invalid auth response" }, 401);
    }

    const path = join("./stashes", id, "devices.json");
    const data = existsSync(path)
        ? JSON.parse(await readFile(path, "utf-8")) as { devices: Device[] }
        : { devices: [] };

    const currentDevice = data.devices.find(device => device.id === deviceId);
    if (!currentDevice) {
        return c.json({ error: "Unknown device" }, 401);
    }

    currentDevice.lastSeenAt = Date.now();
    currentDevice.lastSeenLabel = "Last seen just now";
    await writeFile(path, JSON.stringify(data, null, 4));

    challenges.delete(id);
    const token = randomBytes(32).toString("hex");
    sessions.set(token, {
        stashId: id,
        deviceId: currentDevice.id,
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000
    });

    return c.json({ token, deviceId: currentDevice.id });
});

app.get("/stash/:id/recovery", async c => {
    const id = c.req.param("id");
    const reg = JSON.parse(await readFile(join("./stashes", "registry.json"), "utf-8")) as Registry;
    if (!reg.stashes[id]) return c.json({ error: "Not found" }, 404);

    const data = await readFile(join("./stashes", id, "recovery.json"), "utf-8");
    return c.json(JSON.parse(data));
});

app.get("/recovery/:recoveryId", async c => {
    const recoveryId = c.req.param("recoveryId");
    const reg = JSON.parse(await readFile(join("./stashes", "registry.json"), "utf-8")) as Registry;
    const stash = Object.values(reg.stashes).find(s => s.recoveryId === recoveryId);
    if (!stash) return c.json({ error: "Not found" }, 404);

    const data = JSON.parse(await readFile(join("./stashes", stash.id, "recovery.json"), "utf-8"));
    return c.json({ stashId: stash.id, ...data });
});

app.post("/recovery/:recoveryId/device", async c => {
    const recoveryId = c.req.param("recoveryId");

    const reg = JSON.parse(await readFile(join("./stashes", "registry.json"), "utf-8")) as Registry;
    const stash = Object.values(reg.stashes).find(s => s.recoveryId === recoveryId);
    if (!stash) return c.json({ error: "Not found" }, 404);

    const { name, type } = await c.req.json<{
        name: string,
        type: "desktop" | "mobile" | "tablet" | "server"
    }>();

    if (!name || typeof name !== "string") {
        return c.json({ error: "Missing device name" }, 400);
    }

    if (!["desktop", "mobile", "tablet", "server"].includes(type)) {
        return c.json({ error: "Invalid device type" }, 400);
    }

    const path = join("./stashes", stash.id, "devices.json");

    if (!existsSync(path)) {
        await writeFile(path, JSON.stringify({ devices: [] }, null, 4));
    }

    const data = JSON.parse(await readFile(path, "utf-8")) as { devices: Device[] };

    const device: Device = {
        id: "dev-" + randomBytes(8).toString("hex"),
        name: name.trim(),
        type,
        addedAt: Date.now(),
        lastSeenAt: Date.now(),
        lastSeenLabel: "Last seen just now",
    };

    data.devices.unshift(device);
    await writeFile(path, JSON.stringify(data, null, 4));

    return c.json({ stashId: stash.id, device }, 201);
});

app.get("/stash/:id/metadata", async c => {
    const id = c.req.param("id");

    if (!auth(c, id)) return c.json({ error: "Unauthorized" }, 401);

    const path = join("./stashes", id, "metadata.bin");
    if (!existsSync(path)) return c.json({ error: "No metadata yet" }, 404);

    const data = await readFile(path);
    return new Response(data, { headers: { "Content-Type": "application/octet-stream" } });
});

app.put("/stash/:id/metadata", async c => {
    const id = c.req.param("id");

    if (!auth(c, id)) return c.json({ error: "Unauthorized" }, 401);

    const data = await c.req.arrayBuffer();
    await writeFile(join("./stashes", id, "metadata.bin"), Buffer.from(data));

    return c.json({ ok: true });
});

app.post("/stash/:id/blob/start", async c => {
    const id = c.req.param("id");
    if (!auth(c, id)) return c.json({ error: "Unauthorized" }, 401);

    const totalUsed = await getDirectorySize(STASHES_ROOT);
    if (totalUsed >= MAX_TOTAL_STORAGE) {
        return c.json({ error: "Server storage is full" }, 507);
    }

    const blobId = randomBytes(16).toString("hex");
    const tempDir = join(STASHES_ROOT, id, "temp", blobId);

    await mkdir(tempDir, { recursive: true });
    await writeFile(join(tempDir, "session.json"), JSON.stringify({ createdAt: Date.now() }, null, 4));

    return c.json({ blobId }, 201);
});

app.put("/stash/:id/blob/:blobId/chunk/:index", async c => {
    const id = c.req.param("id");
    if (!auth(c, id)) return c.json({ error: "Unauthorized" }, 401);

    const blobId = c.req.param("blobId");
    const index = parseInt(c.req.param("index"));
    if (isNaN(index) || index < 0) return c.json({ error: "Invalid chunk index" }, 400);

    const tempDir = join(STASHES_ROOT, id, "temp", blobId);
    if (!existsSync(tempDir)) return c.json({ error: "Upload session not found" }, 404);

    const reg = JSON.parse(await readFile(REGISTRY_PATH, "utf-8")) as Registry;
    if (!reg.stashes[id]) return c.json({ error: "Not found" }, 404);

    const chunkPath = join(tempDir, String(index).padStart(6, "0"));
    const existingChunkSize = (await stat(chunkPath).catch(() => null))?.size || 0;

    let tempSize = 0;
    const tempEntries = await readdir(tempDir, { withFileTypes: true });

    for (const entry of tempEntries) {
        if (!entry.isFile()) continue;
        if (entry.name === "session.json") continue;

        const info = await stat(join(tempDir, entry.name)).catch(() => null);
        tempSize += info?.size || 0;
    }

    const contentLength = parseInt(c.req.header("Content-Length") || "0");

    if (contentLength > 0) {
        const projectedTempSize = tempSize - existingChunkSize + contentLength;

        if (reg.stashes[id].quotaUsed + projectedTempSize > QUOTA) {
            return c.json({ error: "Quota exceeded" }, 413);
        }

        const totalUsed = await getDirectorySize(STASHES_ROOT);
        const projectedTotalUsed = totalUsed + Math.max(0, contentLength - existingChunkSize);

        if (projectedTotalUsed > MAX_TOTAL_STORAGE) {
            return c.json({ error: "Server storage is full" }, 507);
        }
    }

    await pipeline(Readable.fromWeb(c.req.raw.body as any), createWriteStream(chunkPath));

    tempSize = 0;
    const finalTempEntries = await readdir(tempDir, { withFileTypes: true });

    for (const entry of finalTempEntries) {
        if (!entry.isFile()) continue;
        if (entry.name === "session.json") continue;

        const info = await stat(join(tempDir, entry.name)).catch(() => null);
        tempSize += info?.size || 0;
    }

    if (reg.stashes[id].quotaUsed + tempSize > QUOTA) {
        await unlink(chunkPath).catch(() => { });
        return c.json({ error: "Quota exceeded" }, 413);
    }

    return c.json({ ok: true });
});

app.post("/stash/:id/blob/:blobId/complete", async c => {
    const id = c.req.param("id");
    if (!auth(c, id)) return c.json({ error: "Unauthorized" }, 401);

    const blobId = c.req.param("blobId");
    const { chunkCount } = await c.req.json<{ chunkCount: number }>();

    if (!Number.isInteger(chunkCount) || chunkCount <= 0) {
        return c.json({ error: "Invalid chunkCount" }, 400);
    }

    const tempDir = join(STASHES_ROOT, id, "temp", blobId);
    if (!existsSync(tempDir)) return c.json({ error: "Upload session not found" }, 404);

    const reg = JSON.parse(await readFile(REGISTRY_PATH, "utf-8")) as Registry;
    if (!reg.stashes[id]) return c.json({ error: "Not found" }, 404);

    let tempSize = 0;
    const tempEntries = await readdir(tempDir, { withFileTypes: true });

    for (const entry of tempEntries) {
        if (!entry.isFile()) continue;
        if (entry.name === "session.json") continue;

        const info = await stat(join(tempDir, entry.name)).catch(() => null);
        tempSize += info?.size || 0;
    }

    if (reg.stashes[id].quotaUsed + tempSize > QUOTA) {
        await rm(tempDir, { recursive: true, force: true });
        return c.json({ error: "Quota exceeded" }, 413);
    }

    const totalUsed = await getDirectorySize(STASHES_ROOT);
    if (totalUsed > MAX_TOTAL_STORAGE) {
        await rm(tempDir, { recursive: true, force: true });
        return c.json({ error: "Server storage is full" }, 507);
    }

    const blobPath = join(STASHES_ROOT, id, "blobs", blobId);
    const dest = createWriteStream(blobPath);

    try {
        for (let i = 0; i < chunkCount; i++) {
            const chunkPath = join(tempDir, String(i).padStart(6, "0"));

            if (!existsSync(chunkPath)) {
                dest.destroy();
                await unlink(blobPath).catch(() => { });
                await rm(tempDir, { recursive: true, force: true });
                return c.json({ error: `Missing chunk ${i}` }, 400);
            }

            await new Promise<void>((resolve, reject) => {
                const src = createReadStream(chunkPath);

                src.on("error", reject);
                dest.on("error", reject);
                src.on("end", resolve);

                src.pipe(dest, { end: false });
            });
        }

        await new Promise<void>((resolve, reject) => {
            dest.end((err: Error | null | undefined) => err ? reject(err) : resolve());
        });
    } catch (error) {
        dest.destroy();
        await unlink(blobPath).catch(() => { });
        await rm(tempDir, { recursive: true, force: true });
        throw error;
    }

    await rm(tempDir, { recursive: true, force: true });

    const { size } = await stat(blobPath);

    if (reg.stashes[id].quotaUsed + size > QUOTA) {
        await unlink(blobPath).catch(() => { });
        return c.json({ error: "Quota exceeded" }, 413);
    }

    reg.stashes[id].quotaUsed += size;
    await writeFile(REGISTRY_PATH, JSON.stringify(reg, null, 4));

    return c.json({ blobId });
});

app.get("/stash/:id/blob/:blobId", async c => {
    const id = c.req.param("id");
    if (!auth(c, id)) return c.json({ error: "Unauthorized" }, 401);

    const blobPath = join("./stashes", id, "blobs", c.req.param("blobId"));
    if (!existsSync(blobPath)) return c.json({ error: "Blob not found" }, 404);

    const { size } = await stat(blobPath);
    const webStream = Readable.toWeb(createReadStream(blobPath)) as ReadableStream;

    return new Response(webStream, {
        headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(size),
        }
    });
});

app.delete("/stash/:id/blob/:blobId", async c => {
    const id = c.req.param("id");

    if (!auth(c, id)) return c.json({ error: "Unauthorized" }, 401);

    const path = join("./stashes", id, "blobs", c.req.param("blobId"));
    if (!existsSync(path)) return c.json({ error: "Blob not found" }, 404);

    const { size } = await stat(path);
    await unlink(path);

    const reg = JSON.parse(await readFile(join("./stashes", "registry.json"), "utf-8")) as Registry;
    reg.stashes[id].quotaUsed = Math.max(0, reg.stashes[id].quotaUsed - size);
    await writeFile(join("./stashes", "registry.json"), JSON.stringify(reg, null, 4));

    return c.json({ ok: true });
});

app.delete("/stash/:id/blobs", async c => {
    const id = c.req.param("id");

    if (!auth(c, id)) return c.json({ error: "Unauthorized" }, 401);

    const { blobIds } = await c.req.json<{ blobIds: string[] }>();

    if (!Array.isArray(blobIds) || blobIds.some(blobId => typeof blobId !== "string")) {
        return c.json({ error: "Invalid blobIds" }, 400);
    }

    let freedBytes = 0;

    for (const blobId of blobIds) {
        const path = join("./stashes", id, "blobs", blobId);
        if (!existsSync(path)) continue;

        const { size } = await stat(path);
        await unlink(path);
        freedBytes += size;
    }

    const reg = JSON.parse(await readFile(join("./stashes", "registry.json"), "utf-8")) as Registry;
    reg.stashes[id].quotaUsed = Math.max(0, reg.stashes[id].quotaUsed - freedBytes);
    await writeFile(join("./stashes", "registry.json"), JSON.stringify(reg, null, 4));

    return c.json({ ok: true });
});

app.get("/stash/:id/devices", async c => {
    const id = c.req.param("id");

    const session = getSession(c, id);
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const path = join("./stashes", id, "devices.json");

    if (!existsSync(path)) {
        await writeFile(path, JSON.stringify({ devices: [] }, null, 4));
    }

    const data = JSON.parse(await readFile(path, "utf-8")) as { devices: Device[] };
    return c.json({ devices: data.devices, currentDeviceId: session.deviceId });
});

app.post("/stash/:id/devices", async c => {
    const id = c.req.param("id");

    if (!auth(c, id)) return c.json({ error: "Unauthorized" }, 401);

    const { name, type } = await c.req.json<{
        name: string,
        type: "desktop" | "mobile" | "tablet" | "server"
    }>();

    if (!name || typeof name !== "string") return c.json({ error: "Missing device name" }, 400);
    if (!["desktop", "mobile", "tablet", "server"].includes(type)) {
        return c.json({ error: "Invalid device type" }, 400);
    }

    const path = join("./stashes", id, "devices.json");

    if (!existsSync(path)) {
        await writeFile(path, JSON.stringify({ devices: [] }, null, 4));
    }

    const data = JSON.parse(await readFile(path, "utf-8")) as { devices: Device[] };

    const device: Device = {
        id: "dev-" + randomBytes(8).toString("hex"),
        name: name.trim(),
        type,
        addedAt: Date.now(),
        lastSeenAt: Date.now(),
        lastSeenLabel: "Last seen just now",
    };

    data.devices.unshift(device);
    await writeFile(path, JSON.stringify(data, null, 4));

    return c.json({ device }, 201);
});

app.patch("/stash/:id/devices/:deviceId", async c => {
    const id = c.req.param("id");
    const deviceId = c.req.param("deviceId");

    if (!auth(c, id)) return c.json({ error: "Unauthorized" }, 401);

    const { name } = await c.req.json<{ name: string }>();
    if (!name || typeof name !== "string") return c.json({ error: "Missing device name" }, 400);

    const path = join("./stashes", id, "devices.json");

    if (!existsSync(path)) {
        await writeFile(path, JSON.stringify({ devices: [] }, null, 4));
    }

    const data = JSON.parse(await readFile(path, "utf-8")) as { devices: Device[] };
    const device = data.devices.find(device => device.id === deviceId);

    if (!device) {
        return c.json({ error: "Device not found" }, 404);
    }

    device.name = name.trim();

    await writeFile(path, JSON.stringify(data, null, 4));
    return c.json({ device });
});

app.delete("/stash/:id/devices/:deviceId", async c => {
    const id = c.req.param("id");
    const deviceId = c.req.param("deviceId");

    const session = getSession(c, id);
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const path = join("./stashes", id, "devices.json");

    if (!existsSync(path)) {
        await writeFile(path, JSON.stringify({ devices: [] }, null, 4));
    }

    const data = JSON.parse(await readFile(path, "utf-8")) as { devices: Device[] };

    if (deviceId === session.deviceId) {
        return c.json({ error: "You cannot remove the current device" }, 400);
    }

    if (data.devices.length <= 1) {
        return c.json({ error: "Cannot remove the last device" }, 400);
    }

    const before = data.devices.length;
    data.devices = data.devices.filter(device => device.id !== deviceId);

    if (data.devices.length === before) {
        return c.json({ error: "Device not found" }, 404);
    }

    await writeFile(path, JSON.stringify(data, null, 4));
    return c.json({ ok: true });
});

app.get("/stash/:id/quota", async c => {
    const id = c.req.param("id");

    if (!auth(c, id)) return c.json({ error: "Unauthorized" }, 401);

    const reg = JSON.parse(await readFile(join("./stashes", "registry.json"), "utf-8")) as Registry;
    if (!reg.stashes[id]) return c.json({ error: "Not found" }, 404);

    return c.json({ used: reg.stashes[id].quotaUsed, limit: QUOTA });
});

app.post("/stash/:id/access-code", async c => {
    const id = c.req.param("id");
    if (!auth(c, id)) return c.json({ error: "Unauthorized" }, 401);

    const body = await c.req.json<{
        device?: { name: string, type: "desktop" | "mobile" | "tablet" | "server" }
    }>().catch(() => ({ device: undefined }));

    const { device } = body;

    if (device && (!device.name || !["desktop", "mobile", "tablet", "server"].includes(device.type))) {
        return c.json({ error: "Invalid device payload" }, 400);
    }

    for (const [k, v] of accessCodes) if (v.stashId === id) accessCodes.delete(k);

    const code = randomBytes(3).toString("hex").toUpperCase();
    accessCodes.set(code, {
        stashId: id,
        expiresAt: Date.now() + 10 * 60 * 1000,
        pendingDevice: device
    });

    return c.json({ code, expiresIn: 600 });
});

app.put("/stash/:id/access-code/:code", async c => {
    const id = c.req.param("id");
    const code = c.req.param("code").toUpperCase();

    if (!auth(c, id)) return c.json({ error: "Unauthorized" }, 401);

    const entry = accessCodes.get(code);
    if (!entry || entry.stashId !== id || Date.now() > entry.expiresAt) {
        accessCodes.delete(code);
        return c.json({ error: "Invalid or expired code" }, 404);
    }

    const { transfer } = await c.req.json<{
        transfer: { iv: string, encryptedKey: string, salt: string }
    }>();

    if (!transfer?.iv || !transfer?.encryptedKey || !transfer?.salt) {
        return c.json({ error: "Missing transfer blob" }, 400);
    }

    entry.transfer = transfer;
    accessCodes.set(code, entry);

    return c.json({ ok: true });
});

app.post("/stash/join/:token", async c => {
    const code = c.req.param("token").toUpperCase();
    const entry = accessCodes.get(code);

    if (!entry || Date.now() > entry.expiresAt) {
        accessCodes.delete(code);
        return c.json({ error: "Invalid or expired code" }, 404);
    }

    const body = await c.req.json().catch(() => ({})) as {
        deviceName?: string;
        deviceType?: "desktop" | "mobile" | "tablet" | "server";
    };

    if (!entry.transfer) {
        return c.json({ error: "Access code not ready yet" }, 409);
    }

    const { stashId, transfer, pendingDevice } = entry;
    accessCodes.delete(code);

    const resolvedName =
        pendingDevice?.name?.trim() ||
        (typeof body.deviceName === "string" ? body.deviceName.trim() : "");

    const resolvedType =
        pendingDevice?.type ||
        (["desktop", "mobile", "tablet", "server"].includes(body.deviceType || "")
            ? body.deviceType
            : undefined);

    let joinedDevice: Device | null = null;

    if (resolvedName && resolvedType) {
        const path = join("./stashes", stashId, "devices.json");

        if (!existsSync(path)) {
            await writeFile(path, JSON.stringify({ devices: [] }, null, 4));
        }

        const data = JSON.parse(await readFile(path, "utf-8")) as { devices: Device[] };

        joinedDevice = {
            id: "dev-" + randomBytes(8).toString("hex"),
            name: resolvedName,
            type: resolvedType,
            addedAt: Date.now(),
            lastSeenAt: Date.now(),
            lastSeenLabel: "Last seen just now",
        };

        data.devices.unshift(joinedDevice);
        await writeFile(path, JSON.stringify(data, null, 4));
    }

    return c.json({ stashId, transfer, device: joinedDevice });
});

app.use("/*", serveStatic({ root: "./frontend" }));

serve({ fetch: app.fetch, port: 6003 }, info => {
    console.log(`Listening at http://localhost:${info.port}`);
});