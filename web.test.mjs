import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { keepAlive } from "./web.mjs";

const fakeRes = (over = {}) => Object.assign(new EventEmitter(), { headersSent: true, writableEnded: false, destroyed: false, written: [], write(s) { this.written.push(s); } }, over);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("keepAlive: 静かなあいだ、everyMs ごとにコメント行を流す", async () => {
  const res = fakeRes();
  const stop = keepAlive(res, 20);
  await sleep(75);
  stop();
  assert.ok(res.written.length >= 2);
  assert.ok(res.written.every((s) => s === ": keep-alive\n\n"));
});

test("keepAlive: 返事の頭を送る前・終えたあとは書かない。止めたら止まる。res が閉じても止まる", async () => {
  const early = fakeRes({ headersSent: false });
  const stopEarly = keepAlive(early, 10);
  await sleep(35);
  stopEarly();
  assert.equal(early.written.length, 0);

  const ended = fakeRes({ writableEnded: true });
  const stopEnded = keepAlive(ended, 10);
  await sleep(35);
  stopEnded();
  assert.equal(ended.written.length, 0);

  const closing = fakeRes();
  keepAlive(closing, 10);
  await sleep(25);
  closing.emit("close");
  const n = closing.written.length;
  await sleep(35);
  assert.equal(closing.written.length, n);
});
