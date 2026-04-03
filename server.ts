import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

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

serve({ fetch: app.fetch, port: 6003 }, info => {
    console.log(`Listening at http://localhost:${info.port}`);
});