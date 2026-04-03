import { Hono } from "hono";
import { serve } from "@hono/node-server";

const app = new Hono();

app.get("/", (c) => {
    return c.text("Hello, World!");
});

serve({ fetch: app.fetch, port: 6003 }, info => {
    console.log(`Listening at http://localhost:${info.port}`);
});