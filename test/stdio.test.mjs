// End-to-end: start the real MCP server over stdio against a local fake Copper API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

function fakeCopper() {
  const seen = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.setHeader("Content-Type", "application/json");
      const send = (x) => res.end(JSON.stringify(x));
      const path = req.url;
      if (path === "/pipelines") return send([{ id: 1, name: "Sales", stages: [{ id: 10, name: "Qualified" }, { id: 11, name: "Proposal" }] }]);
      if (path === "/opportunities/search") {
        return send([
          { id: 7, name: "Acme renewal", status: "Open", monetary_value: 12000, pipeline_id: 1, pipeline_stage_id: 11 },
          { id: 8, name: "Globex", status: "Open", monetary_value: 3000, pipeline_id: 1, pipeline_stage_id: 10 },
        ]);
      }
      if (path === "/opportunities/7" && req.method === "PUT") return send({ id: 7, pipeline_stage_id: 10 });
      if (path === "/activities" && req.method === "POST") return send({ id: 99, details: JSON.parse(body).details });
      res.statusCode = 404;
      send({ message: "Resource not found" });
    });
  });
  return { srv, seen };
}

function rpcClient(child) {
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  let id = 0;
  return {
    request(method, params) {
      const myId = ++id;
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
      return new Promise((resolve, reject) => {
        pending.set(myId, resolve);
        setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10000);
      });
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    },
  };
}

test("MCP handshake, tool listing, pipeline review and a stage update", async () => {
  const { srv, seen } = fakeCopper();
  srv.listen(0);
  await once(srv, "listening");
  const port = srv.address().port;

  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, COPPER_API_KEY: "key_test", COPPER_USER_EMAIL: "rep@acme.com", COPPER_BASE_URL: `http://127.0.0.1:${port}` },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const rpc = rpcClient(child);
    const init = await rpc.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" },
    });
    assert.equal(init.result.serverInfo.name, "copper-mcp");
    rpc.notify("notifications/initialized", {});

    const list = await rpc.request("tools/list", {});
    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "complete_task",
      "create_opportunity",
      "create_task",
      "find_person_by_email",
      "get_account_info",
      "get_opportunity",
      "list_activities",
      "list_pipelines",
      "log_activity",
      "search_companies",
      "search_opportunities",
      "search_people",
      "search_tasks",
      "update_opportunity",
    ]);
    assert.equal(list.result.tools.find((t) => t.name === "search_opportunities").annotations.readOnlyHint, true);

    const review = await rpc.request("tools/call", {
      name: "search_opportunities",
      arguments: { statuses: ["Open"], close_before: "2026-12-31" },
    });
    const parsed = JSON.parse(review.result.content[0].text);
    assert.equal(parsed.totalValue, 15000);
    assert.deepEqual(parsed.byStage.Proposal, { count: 1, value: 12000 });
    const searchBody = JSON.parse(seen.find((s) => s.url === "/opportunities/search").body);
    assert.deepEqual(searchBody.status_ids, [0]);
    assert.equal(searchBody.maximum_close_date, 1798675200);

    const moved = await rpc.request("tools/call", {
      name: "update_opportunity",
      arguments: { opportunity_id: 7, pipeline_stage_id: 10, close_date: "2026-11-30" },
    });
    assert.equal(JSON.parse(moved.result.content[0].text).pipeline_stage_id, 10);
    assert.deepEqual(JSON.parse(seen.find((s) => s.method === "PUT").body), { pipeline_stage_id: 10, close_date: "11/30/2026" });

    const note = await rpc.request("tools/call", {
      name: "log_activity",
      arguments: { parent_type: "opportunity", parent_id: 7, details: "Sent revised quote" },
    });
    assert.equal(JSON.parse(note.result.content[0].text).id, 99);
    const act = JSON.parse(seen.find((s) => s.url === "/activities").body);
    assert.deepEqual(act.type, { category: "user", id: 0 });

    assert.ok(seen.every((s) => s.headers["x-pw-accesstoken"] === "key_test" && s.headers["x-pw-useremail"] === "rep@acme.com"));

    const bad = await rpc.request("tools/call", { name: "get_opportunity", arguments: { opportunity_id: 404 } });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /Copper API 404/);
  } finally {
    child.kill();
    srv.close();
  }
});
