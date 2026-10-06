import { test } from "node:test";
import assert from "node:assert/strict";
import { CopperClient, summarizeOpportunities, stripEmpty, toUnix, BASE_URL } from "../dist/client.js";

function mockFetch(responder) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, ...init });
    const { status = 200, body = {} } = (await responder(url, init)) ?? {};
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  fn.calls = calls;
  return fn;
}

test("sends Copper's three auth headers", async () => {
  const f = mockFetch(() => ({ body: { id: 1, name: "Acme" } }));
  const c = new CopperClient({ apiKey: "key_1", userEmail: "me@acme.com", fetch: f });
  assert.deepEqual(await c.account(), { id: 1, name: "Acme" });
  assert.equal(f.calls[0].url, `${BASE_URL}/account`);
  assert.equal(f.calls[0].headers["X-PW-AccessToken"], "key_1");
  assert.equal(f.calls[0].headers["X-PW-UserEmail"], "me@acme.com");
  assert.equal(f.calls[0].headers["X-PW-Application"], "developer_api");
});

test("search bodies drop empty filters", async () => {
  const f = mockFetch(() => ({ body: [] }));
  const c = new CopperClient({ apiKey: "k", userEmail: "e@x.co", fetch: f });
  await c.searchOpportunities({ name: "Big", status_ids: [0], tags: [], assignee_ids: undefined, page_size: 50 });
  assert.equal(f.calls[0].method, "POST");
  assert.ok(f.calls[0].url.endsWith("/opportunities/search"));
  assert.deepEqual(JSON.parse(f.calls[0].body), { name: "Big", status_ids: [0], page_size: 50 });
  assert.deepEqual(stripEmpty({ a: null, b: { c: undefined, d: 1 } }), { b: { d: 1 } });
});

test("updates and creates with the right verbs", async () => {
  const f = mockFetch(() => ({ body: { id: 9 } }));
  const c = new CopperClient({ apiKey: "k", userEmail: "e@x.co", fetch: f });
  await c.updateOpportunity(9, { pipeline_stage_id: 3 });
  assert.equal(f.calls[0].method, "PUT");
  assert.ok(f.calls[0].url.endsWith("/opportunities/9"));
  await c.createActivity({ parent: { type: "person", id: 5 }, type: { category: "user", id: 0 }, details: "hi" });
  assert.ok(f.calls[1].url.endsWith("/activities"));
  await c.fetchPersonByEmail("a@b.co");
  assert.deepEqual(JSON.parse(f.calls[2].body), { email: "a@b.co" });
});

test("surfaces API errors with status and body", async () => {
  const f = mockFetch(() => ({ status: 422, body: { message: "Invalid stage" } }));
  const c = new CopperClient({ apiKey: "k", userEmail: "e@x.co", fetch: f });
  await assert.rejects(() => c.updateOpportunity(1, {}), /Copper API 422 .*Invalid stage/);
});

test("converts dates to unix seconds", () => {
  assert.equal(toUnix("2026-10-06T00:00:00Z"), 1791244800);
  assert.equal(toUnix("1791244800"), 1791244800);
  assert.equal(toUnix(undefined), undefined);
});

test("summarizes deals by status and named stage", () => {
  const pipelines = [{ id: 1, name: "Sales", stages: [{ id: 10, name: "Qualified" }, { id: 11, name: "Proposal" }] }];
  const s = summarizeOpportunities(
    [
      { id: 1, name: "A", status: "Open", monetary_value: 1000, pipeline_id: 1, pipeline_stage_id: 10 },
      { id: 2, name: "B", status: "Open", monetary_value: 2500, pipeline_id: 1, pipeline_stage_id: 11, date_stage_changed: 1791244800 },
      { id: 3, name: "C", status: "Won", monetary_value: 500, pipeline_id: 1, pipeline_stage_id: 11 },
    ],
    pipelines,
  );
  assert.equal(s.totalValue, 4000);
  assert.deepEqual(s.byStatus.Open, { count: 2, value: 3500 });
  assert.deepEqual(s.byStage.Proposal, { count: 2, value: 3000 });
  assert.equal(s.opportunities[1].stage, "Proposal");
  assert.equal(s.opportunities[1].pipeline, "Sales");
  assert.equal(s.opportunities[1].stage_changed, "2026-10-06T00:00:00.000Z");
});
