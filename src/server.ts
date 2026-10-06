import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CopperClient, OPPORTUNITY_STATUSES, STATUS_ID, summarizeOpportunities, toUnix, fromUnix } from "./client.js";

export const VERSION = "0.1.0";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}

const RO = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const UPDATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const id = (what: string) => z.number().int().positive().describe(`${what} ID (numeric)`);
const ids = (what: string) => z.array(z.number().int()).optional().describe(`${what} IDs`);
const date = (what: string) => z.string().optional().describe(`${what}, ISO 8601 date, e.g. 2026-10-31`);
const page = {
  page_size: z.number().int().min(1).max(200).optional().describe("Results per page, 1-200 (default 20)"),
  page_number: z.number().int().min(1).optional().describe("Page number, starting at 1"),
};
const parentType = z.enum(["person", "company", "lead", "opportunity", "project"]);

/** Copper wants close_date as M/D/YYYY. */
function toCopperDate(iso?: string): string | undefined {
  if (!iso) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${Number(m[2])}/${Number(m[3])}/${m[1]}`;
}

function compactPerson(p: Record<string, unknown>) {
  const emails = (p.emails as { email: string }[] | undefined) ?? [];
  const phones = (p.phone_numbers as { number: string }[] | undefined) ?? [];
  return {
    id: p.id,
    name: p.name,
    title: p.title,
    company: p.company_name,
    company_id: p.company_id,
    emails: emails.map((e) => e.email),
    phones: phones.map((x) => x.number),
    assignee_id: p.assignee_id,
    tags: p.tags,
    last_contacted: fromUnix(p.date_last_contacted),
  };
}

export function createServer(client: CopperClient): McpServer {
  const server = new McpServer({ name: "copper-mcp", version: VERSION });

  server.registerTool(
    "get_account_info",
    {
      title: "Account, me and users",
      description:
        "Get the Copper account, the API user, and all users with their IDs. Use the user IDs as assignee_id in other tools.",
      inputSchema: {},
      annotations: RO,
    },
    async () =>
      run(async () => {
        const [account, me, users] = await Promise.all([client.account(), client.me(), client.listUsers()]);
        return {
          account,
          me,
          users: (Array.isArray(users) ? users : []).map((u) => ({ id: u.id, name: u.name, email: u.email })),
        };
      }),
  );

  server.registerTool(
    "search_people",
    {
      title: "Search people",
      description: "Search contacts (people) by name, email, company, tags, assignee or location. Returns a compact list.",
      inputSchema: {
        name: z.string().optional().describe("Full or partial name"),
        emails: z.array(z.string()).optional(),
        phone_number: z.string().optional(),
        company_ids: ids("Company"),
        assignee_ids: ids("Owner (user)"),
        tags: z.array(z.string()).optional(),
        city: z.string().optional(),
        country: z.string().length(2).optional().describe("Two-letter country code"),
        not_contacted_since: date("Only people last contacted before this date"),
        sort_by: z.string().optional().describe("e.g. name, date_modified, date_last_contacted"),
        sort_direction: z.enum(["asc", "desc"]).optional(),
        raw: z.boolean().optional().describe("Return Copper's full objects"),
        ...page,
      },
      annotations: RO,
    },
    async ({ raw, not_contacted_since, ...q }) =>
      run(async () => {
        const res = await client.searchPeople({ ...q, maximum_interaction_date: toUnix(not_contacted_since) });
        return raw ? res : (Array.isArray(res) ? res : []).map(compactPerson);
      }),
  );

  server.registerTool(
    "find_person_by_email",
    {
      title: "Find person by email",
      description: "Look up one contact by exact email address. Returns the full person record.",
      inputSchema: { email: z.string().email() },
      annotations: RO,
    },
    async ({ email }) => run(() => client.fetchPersonByEmail(email)),
  );

  server.registerTool(
    "search_companies",
    {
      title: "Search companies",
      description: "Search companies by name, tags, assignee or location.",
      inputSchema: {
        name: z.string().optional(),
        assignee_ids: ids("Owner (user)"),
        tags: z.array(z.string()).optional(),
        city: z.string().optional(),
        country: z.string().length(2).optional(),
        sort_by: z.string().optional(),
        sort_direction: z.enum(["asc", "desc"]).optional(),
        ...page,
      },
      annotations: RO,
    },
    async (q) =>
      run(async () => {
        const res = await client.searchCompanies(q);
        return (Array.isArray(res) ? res : []).map((c) => ({
          id: c.id,
          name: c.name,
          domain: c.email_domain,
          assignee_id: c.assignee_id,
          tags: c.tags,
          city: (c.address as Record<string, unknown> | undefined)?.city,
          last_contacted: fromUnix(c.date_last_contacted),
        }));
      }),
  );

  server.registerTool(
    "list_pipelines",
    {
      title: "List pipelines",
      description: "List pipelines with their stages (id, name, win probability). Needed to move deals between stages.",
      inputSchema: {},
      annotations: RO,
    },
    async () => run(() => client.listPipelines()),
  );

  server.registerTool(
    "search_opportunities",
    {
      title: "Search opportunities (deals)",
      description:
        "Search deals by name, status, pipeline, stage, owner, company, value or close date. Returns totals by status and stage (count and value) and a compact list with stage names instead of IDs. Good for pipeline reviews and forecasts.",
      inputSchema: {
        name: z.string().optional(),
        statuses: z.array(z.enum(OPPORTUNITY_STATUSES)).optional().describe("Open, Won, Lost, Abandoned"),
        pipeline_ids: ids("Pipeline"),
        pipeline_stage_ids: ids("Stage"),
        assignee_ids: ids("Owner (user)"),
        company_ids: ids("Company"),
        primary_contact_ids: ids("Primary contact (person)"),
        tags: z.array(z.string()).optional(),
        minimum_monetary_value: z.number().optional(),
        maximum_monetary_value: z.number().optional(),
        close_after: date("Close date on or after"),
        close_before: date("Close date on or before"),
        stage_unchanged_since: date("Only deals whose stage hasn't changed since this date (stale deals)"),
        sort_by: z.string().optional().describe("e.g. name, monetary_value, close_date, date_modified"),
        sort_direction: z.enum(["asc", "desc"]).optional(),
        raw: z.boolean().optional(),
        ...page,
      },
      annotations: RO,
    },
    async ({ statuses, close_after, close_before, stage_unchanged_since, raw, ...q }) =>
      run(async () => {
        const body = {
          ...q,
          status_ids: statuses?.map((s) => STATUS_ID[s]),
          minimum_close_date: toUnix(close_after),
          maximum_close_date: toUnix(close_before),
          maximum_stage_change_date: toUnix(stage_unchanged_since),
        };
        const res = await client.searchOpportunities(body);
        if (raw) return res;
        const pipelines = await client.listPipelines().catch(() => []);
        return summarizeOpportunities(Array.isArray(res) ? res : [], Array.isArray(pipelines) ? pipelines : []);
      }),
  );

  server.registerTool(
    "get_opportunity",
    {
      title: "Get opportunity",
      description: "Get one deal with all fields, including custom fields.",
      inputSchema: { opportunity_id: id("Opportunity") },
      annotations: RO,
    },
    async ({ opportunity_id }) => run(() => client.getOpportunity(opportunity_id)),
  );

  const oppFields = {
    pipeline_id: z.number().int().optional(),
    pipeline_stage_id: z.number().int().optional().describe("Stage ID from list_pipelines"),
    status: z.enum(OPPORTUNITY_STATUSES).optional(),
    monetary_value: z.number().optional(),
    close_date: z.string().optional().describe("Expected close date, ISO 8601 date, e.g. 2026-12-15"),
    assignee_id: z.number().int().optional().describe("Owner user ID"),
    company_id: z.number().int().optional(),
    primary_contact_id: z.number().int().optional().describe("Person ID"),
    priority: z.enum(["None", "Low", "Medium", "High"]).optional(),
    details: z.string().optional().describe("Description"),
    tags: z.array(z.string()).optional(),
  };

  server.registerTool(
    "create_opportunity",
    {
      title: "Create opportunity",
      description: "Create a new deal. Use list_pipelines for pipeline and stage IDs and get_account_info for user IDs.",
      inputSchema: { name: z.string().min(1), ...oppFields },
      annotations: WRITE,
    },
    async ({ close_date, ...o }) => run(() => client.createOpportunity({ ...o, close_date: toCopperDate(close_date) })),
  );

  server.registerTool(
    "update_opportunity",
    {
      title: "Update opportunity",
      description:
        "Update a deal: move it to another stage, mark it Won/Lost, change value, close date, owner or name. Only the fields you pass are changed.",
      inputSchema: {
        opportunity_id: id("Opportunity"),
        name: z.string().optional(),
        loss_reason_id: z.number().int().optional().describe("When marking Lost"),
        ...oppFields,
      },
      annotations: UPDATE,
    },
    async ({ opportunity_id, close_date, ...patch }) =>
      run(() => client.updateOpportunity(opportunity_id, { ...patch, close_date: toCopperDate(close_date) })),
  );

  server.registerTool(
    "search_tasks",
    {
      title: "Search tasks",
      description: "Search tasks by owner, status, due date or related deal. Good for 'what's overdue for me?'.",
      inputSchema: {
        assignee_ids: ids("Owner (user)"),
        statuses: z.array(z.enum(["Open", "Completed"])).optional(),
        opportunity_ids: ids("Opportunity"),
        due_after: date("Due on or after"),
        due_before: date("Due on or before"),
        sort_by: z.string().optional().describe("e.g. due_date, name"),
        sort_direction: z.enum(["asc", "desc"]).optional(),
        ...page,
      },
      annotations: RO,
    },
    async ({ due_after, due_before, ...q }) =>
      run(async () => {
        const res = await client.searchTasks({ ...q, minimum_due_date: toUnix(due_after), maximum_due_date: toUnix(due_before) });
        return (Array.isArray(res) ? res : []).map((t) => ({
          id: t.id,
          name: t.name,
          status: t.status,
          priority: t.priority,
          due: fromUnix(t.due_date),
          assignee_id: t.assignee_id,
          related: t.related_resource,
          details: t.details,
        }));
      }),
  );

  server.registerTool(
    "create_task",
    {
      title: "Create task",
      description: "Create a task, optionally linked to a person, company, lead or opportunity.",
      inputSchema: {
        name: z.string().min(1),
        due_date: z.string().optional().describe("ISO 8601 date or datetime"),
        reminder_date: z.string().optional().describe("ISO 8601 datetime"),
        assignee_id: z.number().int().optional(),
        priority: z.enum(["None", "High"]).optional(),
        details: z.string().optional(),
        related_type: parentType.optional(),
        related_id: z.number().int().optional(),
        tags: z.array(z.string()).optional(),
      },
      annotations: WRITE,
    },
    async ({ due_date, reminder_date, related_type, related_id, ...t }) =>
      run(() =>
        client.createTask({
          ...t,
          due_date: toUnix(due_date),
          reminder_date: toUnix(reminder_date),
          related_resource: related_type && related_id ? { type: related_type, id: related_id } : undefined,
        }),
      ),
  );

  server.registerTool(
    "complete_task",
    {
      title: "Complete task",
      description: "Mark a task as Completed.",
      inputSchema: { task_id: id("Task") },
      annotations: UPDATE,
    },
    async ({ task_id }) => run(() => client.updateTask(task_id, { status: "Completed" })),
  );

  server.registerTool(
    "log_activity",
    {
      title: "Log note or activity",
      description:
        "Add a note (default) or another user activity type (call, meeting...) to a person, company, lead or opportunity. Use list_activities with types=true to see activity type IDs.",
      inputSchema: {
        parent_type: parentType,
        parent_id: z.number().int().positive(),
        details: z.string().min(1).describe("The note text"),
        activity_type_id: z.number().int().optional().describe("User activity type ID (default 0 = Note)"),
        activity_date: z.string().optional().describe("ISO 8601 datetime (default now)"),
      },
      annotations: WRITE,
    },
    async ({ parent_type, parent_id, details, activity_type_id, activity_date }) =>
      run(() =>
        client.createActivity({
          parent: { type: parent_type, id: parent_id },
          type: { category: "user", id: activity_type_id ?? 0 },
          details,
          activity_date: toUnix(activity_date),
        }),
      ),
  );

  server.registerTool(
    "list_activities",
    {
      title: "List activities",
      description:
        "Recent activity (notes, emails, calls, meetings, stage changes) for a record, or across the account in a date range. Set types=true to list activity types instead.",
      inputSchema: {
        parent_type: parentType.optional(),
        parent_id: z.number().int().optional(),
        since: date("Only activities on or after"),
        until: date("Only activities on or before"),
        types: z.boolean().optional().describe("Return the activity types (with IDs) instead"),
        ...page,
      },
      annotations: RO,
    },
    async ({ parent_type, parent_id, since, until, types, ...p }) =>
      run(async () => {
        if (types) return client.listActivityTypes();
        const res = await client.searchActivities({
          ...p,
          parent: parent_type && parent_id ? { type: parent_type, id: parent_id } : undefined,
          minimum_activity_date: toUnix(since),
          maximum_activity_date: toUnix(until),
        });
        return (Array.isArray(res) ? res : []).map((a) => ({
          id: a.id,
          type: a.type,
          parent: a.parent,
          date: fromUnix(a.activity_date),
          user_id: a.user_id,
          details: a.details,
        }));
      }),
  );

  return server;
}
