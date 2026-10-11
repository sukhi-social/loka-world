import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

const seen = [];
const fake = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    seen.push({ method: req.method, path: url.pathname, query: url.searchParams, form: new URLSearchParams(body), auth: req.headers.authorization });
    const send = (v) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result: "success", ...v }));
    if (url.pathname === "/api/v1/users")
      return send({ members: [{ user_id: 9, full_name: "Bot", email: "b@x", is_bot: true }, { user_id: 7, full_name: "NyanRus", email: "n@x", is_bot: false }] });
    if (req.method === "POST") return send({ id: 100 });
    send({ messages: [{ id: 1, sender_full_name: "A", sender_id: 7, content: "<p>やあ</p>", type: "stream", display_recipient: "general", subject: "t", timestamp: 0 }] });
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
Object.assign(process.env, { ZULIP_SITE: `http://127.0.0.1:${fake.address().port}/`, ZULIP_EMAIL: "shiro@x", ZULIP_API_KEY: "k" });

const { say, read, zulipConfigured } = await import("./zulip.mjs");
const last = () => seen.at(-1);

test("繋がっているか", () => assert.equal(zulipConfigured(), true));

test("DM は名前から user_id を引いて、bot は選ばない", async () => {
  const r = await say({ text: "こんにちは" });
  assert.deepEqual(r, { id: 100, to: "NyanRus" });
  assert.equal(last().form.get("type"), "direct");
  assert.equal(last().form.get("to"), "[7]");
  assert.equal(last().auth, `Basic ${Buffer.from("shiro@x:k").toString("base64")}`);
});

test("部屋で言うときは、stream と topic に置く", async () => {
  const r = await say({ text: "はい", stream: "general", topic: "朝" });
  assert.deepEqual(r, { id: 100, stream: "general", topic: "朝" });
  assert.equal(last().form.get("to"), "general");
  assert.equal(last().form.get("topic"), "朝");
});

test("topic を省くと (no topic)", async () => {
  assert.equal((await say({ text: "はい", stream: "general" })).topic, "(no topic)");
});

test("部屋を読む。topic を添えると narrow に足される", async () => {
  const out = await read({ stream: "general", topic: "朝", limit: 5 });
  assert.equal(out[0].text, "やあ");
  assert.equal(out[0].stream, "general");
  assert.deepEqual(JSON.parse(last().query.get("narrow")), [
    { operator: "stream", operand: "general" },
    { operator: "topic", operand: "朝" },
  ]);
});

test("知らない人には、見つからないと言う", async () => {
  await assert.rejects(() => read({ to: "だれか" }), /見つかりませんでした/);
});

test.after(() => fake.close());
