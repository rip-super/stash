import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";

interface StashRecord {
    id: string;
    authVerifier: string;
    quotaUsed: number;
    createdAt: number;
}

interface Registry {
    stashes: Record<string, StashRecord>;
}

const app = new Hono();

const challenges = new Map<string, { nonce: string, expiresAt: number }>();
const sessions = new Map<string, { stashId: string, expiresAt: number }>();

await mkdir("./stashes", { recursive: true });
if (!existsSync(join("./stashes", "registry.json"))) {
    await writeFile(join("./stashes", "registry.json"), JSON.stringify({ stashes: {} }, null, 4));
}

app.post("/stash", async c => {
    const { id, authVerifier, recovery } = await c.req.json<{
        id: string,
        authVerifier: string,
        recovery: { salt: string, kdfParams: object, encryptedKey: string };
    }>();

    if (!id || !authVerifier || !recovery) return c.json({ error: "Missing required fields" }, 400);

    const reg = JSON.parse(await readFile(join("./stashes", "registry.json"), "utf-8")) as Registry;
    if (reg.stashes[id]) return c.json({ error: "Stash already exists" }, 409);

    await mkdir(join("./stashes", id, "blobs"), { recursive: true });
    await writeFile(join("./stashes", id, "recovery.json"), JSON.stringify(recovery, null, 4));

    reg.stashes[id] = { id, authVerifier, quotaUsed: 0, createdAt: Date.now() };
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

app.get("/stash/:id/metadata", async c => {
    const id = c.req.param("id");
    const token = c.req.header("Authorization")?.slice(7);
    const session = sessions.get(token ?? "");

    if (!session || session.stashId !== id || Date.now() > session.expiresAt) {
        return c.json({ error: "Unauthorized" }, 401);
    }

    const path = join("./stashes", id, "metadata.bin");
    if (!existsSync(path)) return c.json({ error: "No metadata yet" }, 404);

    const data = await readFile(path);
    return new Response(data, { headers: { "Content-Type": "application/octet-stream" } });
});

app.put("/stash/:id/metadata", async c => {
    const id = c.req.param("id");
    const token = c.req.header("Authorization")?.slice(7);
    const session = sessions.get(token ?? "");
    if (!session || session.stashId !== id || Date.now() > session.expiresAt) {
        return c.json({ error: "Unauthorized" }, 401);
    }

    const data = await c.req.arrayBuffer();
    await writeFile(join("./stashes", id, "metadata.bin"), Buffer.from(data));

    return c.json({ ok: true });
});

serve({ fetch: app.fetch, port: 6003 }, info => {
    console.log(`Listening at http://localhost:${info.port}`);
});