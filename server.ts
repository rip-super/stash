import { Hono, Context } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFile, writeFile, mkdir, stat, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";

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

const app = new Hono();

const challenges = new Map<string, { nonce: string, expiresAt: number }>();
const sessions = new Map<string, { stashId: string, expiresAt: number }>();
const accessCodes = new Map<string, { stashId: string, expiresAt: number, transfer: { iv: string, encryptedKey: string } }>();

const QUOTA = 500 * 1024 * 1024;

await mkdir("./stashes", { recursive: true });
if (!existsSync(join("./stashes", "registry.json"))) {
    await writeFile(join("./stashes", "registry.json"), JSON.stringify({ stashes: {} }, null, 4));
}

function auth(c: Context, id: string) {
    const token = c.req.header("Authorization")?.slice(7);
    const session = sessions.get(token ?? "");
    return session && session.stashId === id && Date.now() <= session.expiresAt;
}

app.post("/stash", async c => {
    const { id, authVerifier, recoveryId, recovery } = await c.req.json<{
        id: string,
        authVerifier: string,
        recoveryId: string,
        recovery: { salt: string, kdfParams: object, iv: string, encryptedKey: string }
    }>();

    if (!id || !authVerifier || !recoveryId || !recovery) return c.json({ error: "Missing required fields" }, 400);

    const reg = JSON.parse(await readFile(join("./stashes", "registry.json"), "utf-8")) as Registry;
    if (reg.stashes[id]) return c.json({ error: "Stash already exists" }, 409);

    await mkdir(join("./stashes", id, "blobs"), { recursive: true });
    await writeFile(join("./stashes", id, "recovery.json"), JSON.stringify(recovery, null, 4));

    reg.stashes[id] = { id, authVerifier, recoveryId, quotaUsed: 0, createdAt: Date.now() };
    await writeFile(join("./stashes", "registry.json"), JSON.stringify(reg, null, 4));

    return c.json({ ok: true }, 201);
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

    const { response } = await c.req.json<{ response: string }>();
    const expected = createHmac("sha256", Buffer.from(reg.stashes[id].authVerifier, "base64")).update(challenge.nonce).digest("hex");

    if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(response, "hex"))) {
        return c.json({ error: "Invalid auth response" }, 401);
    }

    challenges.delete(id);
    const token = randomBytes(32).toString("hex");
    sessions.set(token, { stashId: id, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 });

    return c.json({ token });
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

app.post("/stash/:id/access-code", async c => {
    const id = c.req.param("id");
    if (!auth(c, id)) return c.json({ error: "Unauthorized" }, 401);

    const { transfer } = await c.req.json<{ transfer: { iv: string, encryptedKey: string } }>();
    if (!transfer?.iv || !transfer?.encryptedKey) return c.json({ error: "Missing transfer blob" }, 400);

    for (const [k, v] of accessCodes) if (v.stashId === id) accessCodes.delete(k);

    const code = randomBytes(3).toString("hex").toUpperCase();
    accessCodes.set(code, { stashId: id, expiresAt: Date.now() + 10 * 60 * 1000, transfer });

    return c.json({ code, expiresIn: 600 });
});

app.post("/stash/join/:token", async c => {
    const code = c.req.param("token").toUpperCase();
    const entry = accessCodes.get(code);

    if (!entry || Date.now() > entry.expiresAt) {
        accessCodes.delete(code);
        return c.json({ error: "Invalid or expired code" }, 404);
    }

    const { stashId, transfer } = entry;
    accessCodes.delete(code);

    return c.json({ stashId, transfer });
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

app.post("/stash/:id/blob", async c => {
    const id = c.req.param("id");

    if (!auth(c, id)) return c.json({ error: "Unauthorized" }, 401);

    const data = await c.req.arrayBuffer();
    const reg = JSON.parse(await readFile(join("./stashes", "registry.json"), "utf-8")) as Registry;
    if (reg.stashes[id].quotaUsed + data.byteLength > QUOTA) {
        return c.json({ error: "Quota exceeded" }, 413);
    }

    const blobId = randomBytes(16).toString("hex");
    await writeFile(join("./stashes", id, "blobs", blobId), Buffer.from(data));
    reg.stashes[id].quotaUsed += data.byteLength;
    await writeFile(join("./stashes", "registry.json"), JSON.stringify(reg, null, 2));

    return c.json({ blobId }, 201);
});

app.get("/stash/:id/blob/:blobId", async c => {
    const id = c.req.param("id");

    if (!auth(c, id)) return c.json({ error: "Unauthorized" }, 401);

    const path = join("./stashes", id, "blobs", c.req.param("blobId"));
    if (!existsSync(path)) return c.json({ error: "Blob not found" }, 404);

    const data = await readFile(path);
    return new Response(data, { headers: { "Content-Type": "application/octet-stream" } });
});

app.delete("/stash/:id/blob/:blobId", async c => {
    const id = c.req.param("id");

    if (!auth(c, id)) return c.json({ error: "Unauthorized" }, 401);

    const path = join("./stashes", id, "blobs", c.req.param("blobId"));
    if (!existsSync(path)) return c.json({ error: "Blob not found" }, 404);

    const { size } = await stat(path);
    await unlink(path);

    const reg = JSON.parse(await readFile(join("./stashes", "registry.json"), "utf-8")) as Registry;
    reg.stashes[id].quotaUsed -= size;
    await writeFile(join("./stashes", "registry.json"), JSON.stringify(reg, null, 2));

    return c.json({ ok: true });
});

app.use("/*", serveStatic({ root: "./frontend" }));

serve({ fetch: app.fetch, port: 6003 }, info => {
    console.log(`Listening at http://localhost:${info.port}`);
});