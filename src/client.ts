/**
 * Minimal typed client for the Copper CRM Developer API (v1).
 * Docs: https://developer.copper.com
 *
 * Auth: X-PW-AccessToken (API key), X-PW-UserEmail (the key owner's email),
 * X-PW-Application: developer_api.
 */

export const BASE_URL = "https://api.copper.com/developer_api/v1";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CopperClientOptions {
  apiKey: string;
  userEmail: string;
  baseUrl?: string;
  fetch?: FetchLike;
}

export type Id = number;
export type ParentType = "person" | "company" | "lead" | "opportunity" | "project" | "task";

export const OPPORTUNITY_STATUSES = ["Open", "Won", "Lost", "Abandoned"] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];
/** Copper's numeric status ids, in the documented order. */
export const STATUS_ID: Record<OpportunityStatus, number> = { Open: 0, Won: 1, Lost: 2, Abandoned: 3 };

export type Record_ = Record<string, unknown>;

export class CopperApiError extends Error {
  constructor(
    public status: number,
    public body: string,
    path: string,
  ) {
    super(`Copper API ${status} on ${path}: ${body.slice(0, 500)}`);
    this.name = "CopperApiError";
  }
}

export class CopperClient {
  private headers: Record<string, string>;
  private baseUrl: string;
  private fetchImpl: FetchLike;

  constructor(opts: CopperClientOptions) {
    if (!opts.apiKey) throw new Error("A Copper API key is required (set COPPER_API_KEY).");
    if (!opts.userEmail) throw new Error("The email of the API key's owner is required (set COPPER_USER_EMAIL).");
    this.headers = {
      "X-PW-AccessToken": opts.apiKey,
      "X-PW-Application": "developer_api",
      "X-PW-UserEmail": opts.userEmail,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    this.baseUrl = (opts.baseUrl ?? BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(this.baseUrl + path, {
      method,
      headers: this.headers,
      body: body !== undefined ? JSON.stringify(stripEmpty(body)) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new CopperApiError(res.status, text, path);
    if (!text) return { ok: true } as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return { message: text } as T;
    }
  }

  account() {
    return this.request<Record_>("GET", "/account");
  }
  me() {
    return this.request<Record_>("GET", "/users/me");
  }
  listUsers(pageSize = 200) {
    return this.request<Record_[]>("POST", "/users/search", { page_size: pageSize });
  }

  searchPeople(q: Record_) {
    return this.request<Record_[]>("POST", "/people/search", q);
  }
  fetchPersonByEmail(email: string) {
    return this.request<Record_>("POST", "/people/fetch_by_email", { email });
  }
  getPerson(id: Id) {
    return this.request<Record_>("GET", `/people/${id}`);
  }
  createPerson(p: Record_) {
    return this.request<Record_>("POST", "/people", p);
  }

  searchCompanies(q: Record_) {
    return this.request<Record_[]>("POST", "/companies/search", q);
  }

  listPipelines() {
    return this.request<Record_[]>("GET", "/pipelines");
  }

  searchOpportunities(q: Record_) {
    return this.request<Record_[]>("POST", "/opportunities/search", q);
  }
  getOpportunity(id: Id) {
    return this.request<Record_>("GET", `/opportunities/${id}`);
  }
  createOpportunity(o: Record_) {
    return this.request<Record_>("POST", "/opportunities", o);
  }
  updateOpportunity(id: Id, patch: Record_) {
    return this.request<Record_>("PUT", `/opportunities/${id}`, patch);
  }

  searchTasks(q: Record_) {
    return this.request<Record_[]>("POST", "/tasks/search", q);
  }
  createTask(t: Record_) {
    return this.request<Record_>("POST", "/tasks", t);
  }
  updateTask(id: Id, patch: Record_) {
    return this.request<Record_>("PUT", `/tasks/${id}`, patch);
  }

  searchActivities(q: Record_) {
    return this.request<Record_[]>("POST", "/activities/search", q);
  }
  listActivityTypes() {
    return this.request<Record_>("GET", "/activity_types");
  }
  createActivity(a: Record_) {
    return this.request<Record_>("POST", "/activities", a);
  }
}

/** Drop undefined/null values and empty arrays so search bodies only carry real filters. */
export function stripEmpty<T>(v: T): T {
  if (Array.isArray(v)) return v.map(stripEmpty) as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x === undefined || x === null) continue;
      if (Array.isArray(x) && x.length === 0) continue;
      out[k] = stripEmpty(x);
    }
    return out as T;
  }
  return v;
}

/** ISO date/datetime (or unix seconds) to Copper's unix-seconds timestamps. */
export function toUnix(v: string | number | undefined): number | undefined {
  if (v === undefined || v === "") return undefined;
  if (typeof v === "number") return v;
  if (/^\d{9,11}$/.test(v)) return Number(v);
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`Invalid date: ${v}. Use ISO 8601, e.g. 2026-10-31`);
  return Math.floor(t / 1000);
}

export function fromUnix(v: unknown): string | undefined {
  return typeof v === "number" && v > 0 ? new Date(v * 1000).toISOString() : undefined;
}

/**
 * Summarize opportunities for an LLM: totals by status and stage, plus a compact
 * list with readable dates and stage names instead of ids.
 */
export function summarizeOpportunities(opps: Record_[], pipelines: Record_[] = []) {
  const stageName = new Map<number, string>();
  const pipelineName = new Map<number, string>();
  for (const p of pipelines) {
    pipelineName.set(p.id as number, String(p.name));
    for (const s of (p.stages as Record_[] | undefined) ?? []) stageName.set(s.id as number, String(s.name));
  }
  const byStatus: Record<string, { count: number; value: number }> = {};
  const byStage: Record<string, { count: number; value: number }> = {};
  for (const o of opps) {
    const value = Number(o.monetary_value ?? 0) || 0;
    const st = String(o.status ?? "Unknown");
    byStatus[st] ??= { count: 0, value: 0 };
    byStatus[st].count++;
    byStatus[st].value += value;
    const stage = stageName.get(o.pipeline_stage_id as number) ?? String(o.pipeline_stage_id ?? "none");
    byStage[stage] ??= { count: 0, value: 0 };
    byStage[stage].count++;
    byStage[stage].value += value;
  }
  return {
    total: opps.length,
    totalValue: opps.reduce((a, o) => a + (Number(o.monetary_value ?? 0) || 0), 0),
    byStatus,
    byStage,
    opportunities: opps.map((o) => ({
      id: o.id,
      name: o.name,
      status: o.status,
      value: o.monetary_value,
      currency: o.monetary_unit,
      pipeline: pipelineName.get(o.pipeline_id as number) ?? o.pipeline_id,
      stage: stageName.get(o.pipeline_stage_id as number) ?? o.pipeline_stage_id,
      company: o.company_name,
      assignee_id: o.assignee_id,
      close_date: o.close_date,
      last_contacted: fromUnix(o.date_last_contacted),
      stage_changed: fromUnix(o.date_stage_changed),
    })),
  };
}
