import { createServer } from "node:http";
import { readdir, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { createReadStream, readFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = resolve(__dirname, "public");
const dataDir = resolve(__dirname, "data");
const schedulesFile = join(dataDir, "schedules.json");

loadDotEnv();

const config = {
  token: process.env.GITHUB_TOKEN || "",
  owner: process.env.GITHUB_OWNER || "",
  repo: process.env.GITHUB_REPO || "",
  repos: parseRepos(process.env.GITHUB_REPOS, process.env.GITHUB_OWNER, process.env.GITHUB_REPO),
  port: Number(process.env.PORT || 4173),
  host: process.env.HOST || "127.0.0.1",
  mock: process.env.MOCK_DATA === "true",
};

config.mock = config.mock || !config.token || !config.repos.length;
if (config.mock) {
  config.repos = [
    { owner: "local", repo: "scheduler", key: "local/scheduler", local: true },
  ];
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

let scheduleStates = await readScheduleStates();
const workflowCaches = new Map();
const activeRuns = new Map();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    await serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    sendJson(res, error.status || 500, { error: error.message || "Internal server error" });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`GitHub Actions Scheduler running at http://${config.host}:${config.port}`);
  console.log(config.mock ? "Using mock GitHub data." : `Repositories: ${config.repos.map((repo) => repo.key).join(", ")}`);
});

setInterval(runDueSchedules, 30_000);
setInterval(refreshWorkflowCaches, 5 * 60_000);
setInterval(refreshActiveRuns, 10_000);
refreshWorkflowCaches();

async function handleApi(req, res, url) {
  if (url.pathname === "/api/config" && req.method === "GET") {
    sendJson(res, 200, {
      configured: Boolean(config.token && config.repos.length),
      mock: config.mock,
      repos: config.repos,
      owner: config.repos[0]?.owner || "",
      repo: config.repos[0]?.repo || "",
      hasToken: Boolean(config.token),
    });
    return;
  }

  if (url.pathname === "/api/workflows" && req.method === "GET") {
    const repo = getRepoFromRequest(url);
    const workflowCache = await refreshWorkflowCache(repo, shouldForceRefresh(url));
    sendJson(res, workflowCache.error ? 502 : 200, workflowCache);
    return;
  }

  if (url.pathname === "/api/schedules" && req.method === "GET") {
    const repo = getRepoFromRequest(url);
    const repoSchedules = await getExternalSchedules(repo, shouldForceRefresh(url));
    sendJson(res, 200, { schedules: await enrichSchedulesWithRunLinks(repoSchedules) });
    return;
  }

  if (url.pathname === "/api/runs" && req.method === "GET") {
    const repo = getRepoFromRequest(url);
    await refreshActiveRuns();
    sendJson(res, 200, { runs: [...activeRuns.values()].filter((run) => run.repoKey === repo.key) });
    return;
  }

  if (url.pathname === "/api/schedules" && req.method === "POST") {
    sendJson(res, 405, { error: "Schedules are defined in workflow files with @external-schedule" });
    return;
  }

  const scheduleMatch = url.pathname.match(/^\/api\/schedules\/([^/]+)$/);
  if (scheduleMatch && req.method === "DELETE") {
    sendJson(res, 405, { error: "Schedules are defined in workflow files with @external-schedule" });
    return;
  }

  const triggerMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)\/dispatch$/);
  if (triggerMatch && req.method === "POST") {
    const body = await readJson(req);
    const repo = getRepoFromBody(body);
    const result = await dispatchWorkflow(repo, decodeURIComponent(triggerMatch[1]), body.ref, body.inputs);
    sendJson(res, 200, result);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function serveStatic(req, res, url) {
  const requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = resolve(publicDir, `.${normalize(requestedPath)}`);

  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Not a file");
    res.writeHead(200, { "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream" });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

async function refreshWorkflowCaches() {
  await Promise.all(config.repos.map((repo) => refreshWorkflowCache(repo)));
}

async function refreshWorkflowCache(repo, force = false) {
  if (config.mock) {
    const workflows = await getLocalWorkflows(repo);
    await attachExternalSchedules(repo, workflows);
    const workflowCache = {
      repoKey: repo.key,
      workflows,
      fetchedAt: new Date().toISOString(),
      error: null,
      mock: true,
    };
    workflowCaches.set(repo.key, workflowCache);
    return workflowCache;
  }

  if (!config.token || !repo) {
    const workflowCache = {
      repoKey: repo?.key || "",
      workflows: [],
      fetchedAt: new Date().toISOString(),
      error: "Missing GitHub configuration",
    };
    if (repo) workflowCaches.set(repo.key, workflowCache);
    return workflowCache;
  }

  const cached = workflowCaches.get(repo.key);
  if (!force && cached && Date.now() - Date.parse(cached.fetchedAt) < 30_000) return cached;

  let response;
  try {
    response = await githubFetch(repo, `/repos/${repo.owner}/${repo.repo}/actions/workflows`);
  } catch (error) {
    const workflowCache = {
      repoKey: repo.key,
      workflows: [],
      fetchedAt: new Date().toISOString(),
      error: error.message || "Unable to reach GitHub",
    };
    workflowCaches.set(repo.key, workflowCache);
    return workflowCache;
  }

  if (!response.ok) {
    const workflowCache = {
      repoKey: repo.key,
      workflows: [],
      fetchedAt: new Date().toISOString(),
      error: await response.text(),
    };
    workflowCaches.set(repo.key, workflowCache);
    return workflowCache;
  }

  const data = await response.json();
  const workflowCache = {
    repoKey: repo.key,
    workflows: (data.workflows || []).map((workflow) => ({
      id: workflow.id,
      name: workflow.name,
      path: workflow.path,
      state: workflow.state,
      badgeUrl: workflow.badge_url,
      htmlUrl: workflow.html_url,
      updatedAt: workflow.updated_at,
    })),
    fetchedAt: new Date().toISOString(),
    error: null,
  };
  workflowCaches.set(repo.key, workflowCache);
  await attachExternalSchedules(repo, workflowCache.workflows);
  return workflowCache;
}

async function getLocalWorkflows(repo) {
  const workflowDir = join(__dirname, ".github", "workflows");
  let files = [];
  try {
    files = await readdir(workflowDir);
  } catch {
    return [];
  }

  const workflowFiles = files.filter((file) => /\.(ya?ml)$/i.test(file)).sort();
  return Promise.all(
    workflowFiles.map(async (file) => {
      const path = `.github/workflows/${file}`;
      const content = await readFile(join(__dirname, path), "utf8");
      return {
        id: `${repo.key.replace("/", "-")}-${file.replace(/[^A-Za-z0-9_-]/g, "-")}`,
        name: getWorkflowNameFromContent(content) || file,
        path,
        state: "active",
        badgeUrl: "",
        htmlUrl: `https://github.com/${repo.key}/actions/workflows/${encodeURIComponent(file)}`,
        updatedAt: new Date().toISOString(),
      };
    }),
  );
}

function getWorkflowNameFromContent(content) {
  const match = content.match(/^name:\s*(.+)$/m);
  return match ? parseYamlScalar(match[1]) : "";
}

async function attachExternalSchedules(repo, workflows) {
  await Promise.all(
    workflows.map(async (workflow) => {
      try {
        const content = await readWorkflowFile(repo, workflow);
        const definitions = parseExternalScheduleDefinitions(content);
        workflow.externalSchedules = definitions.map((definition, index) => {
          const schedule = buildExternalSchedule(repo, workflow, definition, index);
          return mergeScheduleState(schedule);
        });
      } catch (error) {
        workflow.externalSchedules = [buildImportFailureSchedule(repo, workflow, error)];
      }
    }),
  );
}

async function getExternalSchedules(repo, force = false) {
  const workflowCache = await refreshWorkflowCache(repo, force);
  return workflowCache.workflows
    .flatMap((workflow) => workflow.externalSchedules || [])
    .sort((a, b) => Number(Boolean(b.importFailed)) - Number(Boolean(a.importFailed)));
}

async function readWorkflowFile(repo, workflow) {
  if (config.mock) {
    return readFile(join(__dirname, workflow.path), "utf8");
  }

  const response = await githubFetch(repo, `/repos/${repo.owner}/${repo.repo}/contents/${encodeURIComponentPath(workflow.path)}`, {
    headers: { Accept: "application/vnd.github.raw+json" },
  });
  if (!response.ok) return "";
  return response.text();
}

function parseExternalScheduleDefinitions(content) {
  const lines = content.split(/\r?\n/);
  const markerIndex = lines.findIndex((line) => /^\s*#\s*@external-schedule:\s*$/.test(line));
  if (markerIndex === -1) return [];

  const block = [];
  for (let index = markerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (!line.trimStart().startsWith("#")) break;
    block.push(line.replace(/^\s*# ?/, ""));
  }

  const configBlock = parseExternalScheduleBlock(block);
  if (configBlock.enabled === false) return [];
  if (!configBlock.schedule.length) {
    throw new Error("@external-schedule must contain at least one schedule item with cron");
  }

  return configBlock.schedule.map((item) => ({
    enabled: item.enabled ?? configBlock.enabled ?? true,
    timezone: item.timezone || configBlock.timezone || "",
    ref: configBlock.ref || "main",
    inputs: { ...(configBlock.inputs || {}), ...(item.inputs || {}) },
    cron: item.cron,
  }));
}

function parseExternalScheduleBlock(lines) {
  const configBlock = { enabled: true, schedule: [], inputs: {} };
  let currentItem = null;
  let inputTarget = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    if (/^\s*#/.test(line)) continue;

    const topLevel = line.match(/^ {2}([A-Za-z0-9_-]+):\s*(.*)$/);
    if (topLevel) {
      const [, key, rawValue] = topLevel;
      inputTarget = null;
      if (key === "schedule") continue;
      if (key === "inputs") {
        inputTarget = configBlock.inputs;
        continue;
      }
      configBlock[key] = parseYamlScalar(rawValue);
      continue;
    }

    const itemStart = line.match(/^ {4}-\s*cron:\s*(.*)$/);
    if (itemStart) {
      currentItem = { cron: parseYamlScalar(itemStart[1]), inputs: {} };
      configBlock.schedule.push(currentItem);
      inputTarget = null;
      continue;
    }

    const itemField = line.match(/^ {6}([A-Za-z0-9_-]+):\s*(.*)$/);
    if (itemField && currentItem) {
      const [, key, rawValue] = itemField;
      if (key === "ref") {
        throw new Error("Per-schedule ref is not allowed; define ref at the top level of @external-schedule");
      }
      if (key === "inputs") {
        inputTarget = currentItem.inputs;
        continue;
      }
      currentItem[key] = parseYamlScalar(rawValue);
      inputTarget = null;
      continue;
    }

    const inputField = line.match(/^ {4,8}([A-Za-z0-9_-]+):\s*(.*)$/);
    if (inputField && inputTarget) {
      inputTarget[inputField[1]] = parseYamlScalar(inputField[2]);
      continue;
    }

    throw new Error(`Could not parse @external-schedule line: "${line.trim()}"`);
  }

  configBlock.schedule = configBlock.schedule.filter((item) => item.cron);
  return configBlock;
}

function parseYamlScalar(value) {
  const trimmed = String(value || "").trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return trimmed.replace(/^["']|["']$/g, "");
}

function buildExternalSchedule(repo, workflow, definition, index) {
  validateCron(definition.cron);
  const id = `${repo.key}:${workflow.id}:${index}:${definition.cron}`;
  return {
    id,
    source: "workflow",
    repoKey: repo.key,
    owner: repo.owner,
    repo: repo.repo,
    workflowId: String(workflow.id),
    workflowName: workflow.name,
    workflowPath: workflow.path,
    workflowHtmlUrl: workflow.htmlUrl || "",
    ref: definition.ref || "main",
    inputs: definition.inputs || {},
    cron: definition.cron,
    timezone: definition.timezone || "",
    enabled: definition.enabled !== false,
    nextRunAt: computeNextRun({ cron: definition.cron, timezone: definition.timezone }, new Date()),
  };
}

function buildImportFailureSchedule(repo, workflow, error) {
  return {
    id: `${repo.key}:${workflow.id}:import-failed`,
    source: "workflow",
    importFailed: true,
    repoKey: repo.key,
    owner: repo.owner,
    repo: repo.repo,
    workflowId: String(workflow.id),
    workflowName: workflow.name,
    workflowPath: workflow.path,
    workflowHtmlUrl: workflow.htmlUrl || "",
    ref: "",
    inputs: {},
    cron: "",
    timezone: "",
    enabled: false,
    nextRunAt: null,
    lastRunAt: null,
    lastStatus: "failed import",
    lastError: error.message || "Failed to parse @external-schedule block",
  };
}

function mergeScheduleState(schedule) {
  return {
    ...schedule,
    ...(scheduleStates[schedule.id] || {}),
    id: schedule.id,
    nextRunAt: computeNextRun(schedule, new Date()),
  };
}

async function dispatchWorkflow(repo, workflowId, ref = "main", inputs = {}) {
  const runKey = getRunKey(repo.key, workflowId);
  const existingRun = activeRuns.get(runKey);
  if (existingRun && isRunActive(existingRun)) {
    throw httpError(409, `${existingRun.workflowName || "Workflow"} is already ${existingRun.status}`);
  }

  if (config.mock) {
    const run = {
      id: `mock-run-${Date.now()}`,
      repoKey: repo.key,
      workflowId: String(workflowId),
      workflowName: getWorkflowName(repo.key, workflowId),
      ref: ref || "main",
      status: "in_progress",
      conclusion: null,
      htmlUrl: `https://github.com/${repo.key}/actions/runs/${Date.now()}`,
      mock: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completesAt: new Date(Date.now() + 60_000).toISOString(),
    };
    activeRuns.set(runKey, run);
    return { ok: true, mock: true, run, dispatchedAt: new Date().toISOString() };
  }

  if (!config.token || !repo) {
    throw httpError(400, "Missing GitHub configuration");
  }

  const dispatchedAfter = new Date(Date.now() - 10_000).toISOString();
  const response = await githubFetch(
    repo,
    `/repos/${repo.owner}/${repo.repo}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`,
    {
      method: "POST",
      body: JSON.stringify({ ref: ref || "main", inputs: inputs || {} }),
    },
  );

  if (!response.ok) {
    throw httpError(response.status, await response.text());
  }

  const run = await findDispatchedRun(repo, workflowId, ref || "main", dispatchedAfter);
  if (run) activeRuns.set(runKey, run);

  return { ok: true, run, dispatchedAt: new Date().toISOString() };
}

async function runDueSchedules() {
  const now = Date.now();
  let changed = false;
  const schedules = (await Promise.all(config.repos.map((repo) => getExternalSchedules(repo)))).flat();

  for (const schedule of schedules) {
    if (!schedule.enabled || !schedule.nextRunAt || Date.parse(schedule.nextRunAt) > now) continue;

    try {
      const repo = getRepoByKey(schedule.repoKey);
      const runKey = getRunKey(schedule.repoKey, schedule.workflowId);
      if (activeRuns.has(runKey) && isRunActive(activeRuns.get(runKey))) {
        updateScheduleState(schedule.id, {
          lastRunAt: new Date().toISOString(),
          lastStatus: "blocked",
          lastError: "Workflow already has an active run",
        });
        changed = true;
        continue;
      }

      const result = await dispatchWorkflow(repo, schedule.workflowId, schedule.ref, schedule.inputs);
      updateScheduleState(schedule.id, {
        lastRunAt: new Date().toISOString(),
        lastStatus: "success",
        lastError: "",
        lastRunUrl: result.run?.htmlUrl || "",
      });
    } catch (error) {
      updateScheduleState(schedule.id, {
        lastRunAt: new Date().toISOString(),
        lastStatus: "failed",
        lastError: error.message || "Dispatch failed",
      });
    }

    changed = true;
  }

  if (changed) await saveScheduleStates();
}

async function refreshActiveRuns() {
  for (const [runKey, run] of activeRuns) {
    const repo = getRepoByKey(run.repoKey);
    if (config.mock) {
      if (run.completesAt && Date.parse(run.completesAt) <= Date.now()) {
        activeRuns.set(runKey, {
          ...run,
          status: "completed",
          conclusion: "success",
          updatedAt: new Date().toISOString(),
        });
      }
      continue;
    }

    if (!run.id) {
      const createdAt = Date.parse(run.createdAt || new Date().toISOString());
      if (Date.now() - createdAt > 2 * 60_000) {
        activeRuns.set(runKey, {
          ...run,
          status: "unknown",
          conclusion: "timed_out",
          error: "Dispatched run was not found in the GitHub API",
          updatedAt: new Date().toISOString(),
        });
        continue;
      }

      const foundRun = await findLatestDispatchedRun(repo, run.workflowId, run.ref, run.createdAt);
      if (foundRun) activeRuns.set(runKey, foundRun);
      continue;
    }

    if (!isRunActive(run)) continue;

    try {
      const updatedRun = await getWorkflowRun(repo, run.id);
      if (updatedRun) activeRuns.set(runKey, updatedRun);
    } catch (error) {
      activeRuns.set(runKey, {
        ...run,
        status: "unknown",
        conclusion: "error",
        error: error.message || "Unable to refresh run status",
        updatedAt: new Date().toISOString(),
      });
    }
  }
}

async function findDispatchedRun(repo, workflowId, ref, dispatchedAfter) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (attempt > 0) await delay(2_000);
    const run = await findLatestDispatchedRun(repo, workflowId, ref, dispatchedAfter);
    if (run) return run;
  }

  return {
    id: null,
    repoKey: repo.key,
    workflowId: String(workflowId),
    workflowName: getWorkflowName(repo.key, workflowId),
    ref,
    status: "queued",
    conclusion: null,
    htmlUrl: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    error: "Dispatched run has not appeared in the GitHub API yet",
  };
}

async function findLatestDispatchedRun(repo, workflowId, ref, dispatchedAfter) {
  const response = await githubFetch(
    repo,
    `/repos/${repo.owner}/${repo.repo}/actions/workflows/${encodeURIComponent(workflowId)}/runs?event=workflow_dispatch&branch=${encodeURIComponent(ref)}&per_page=10`,
  );

  if (!response.ok) throw httpError(response.status, await response.text());

  const data = await response.json();
  const run = (data.workflow_runs || []).find((item) => new Date(item.created_at) >= new Date(dispatchedAfter));
  return run ? normalizeRun(repo.key, workflowId, run) : null;
}

async function getWorkflowRun(repo, runId) {
  const response = await githubFetch(repo, `/repos/${repo.owner}/${repo.repo}/actions/runs/${encodeURIComponent(runId)}`);
  if (!response.ok) throw httpError(response.status, await response.text());
  const run = await response.json();
  return normalizeRun(repo.key, run.workflow_id, run);
}

function normalizeRun(repoKey, workflowId, run) {
  return {
    id: run.id,
    repoKey,
    workflowId: String(workflowId),
    workflowName: run.name || getWorkflowName(repoKey, workflowId),
    ref: run.head_branch || "",
    status: run.status,
    conclusion: run.conclusion,
    htmlUrl: run.html_url,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
  };
}

function isRunActive(run) {
  return Boolean(run && ["queued", "in_progress", "waiting", "requested", "pending"].includes(run.status));
}

function getWorkflowName(repoKey, workflowId) {
  const workflow = workflowCaches.get(repoKey)?.workflows.find((item) => String(item.id) === String(workflowId));
  return workflow?.name || `Workflow ${workflowId}`;
}

function getWorkflowUrl(repoKey, workflowId) {
  const workflow = workflowCaches.get(repoKey)?.workflows.find((item) => String(item.id) === String(workflowId));
  return workflow?.htmlUrl || "";
}

async function enrichSchedulesWithRunLinks(scheduleList) {
  const enriched = [];
  for (const schedule of scheduleList) {
    enriched.push(await enrichScheduleWithRunLink(schedule));
  }
  return enriched;
}

async function enrichScheduleWithRunLink(schedule) {
  if (schedule.importFailed) {
    return {
      ...schedule,
      githubUrl: "",
      latestRun: null,
    };
  }

  const latestRun = await getLatestWorkflowRunForSchedule(schedule);
  return {
    ...schedule,
    workflowHtmlUrl: schedule.workflowHtmlUrl || getWorkflowUrl(schedule.repoKey, schedule.workflowId),
    latestRun,
    githubUrl: latestRun?.htmlUrl || "",
  };
}

async function getLatestWorkflowRunForSchedule(schedule) {
  const activeRun = activeRuns.get(getRunKey(schedule.repoKey, schedule.workflowId));
  if (activeRun?.htmlUrl && (!schedule.ref || activeRun.ref === schedule.ref)) return activeRun;

  if (schedule.lastRunUrl) {
    return {
      htmlUrl: schedule.lastRunUrl,
      status: schedule.lastStatus || "unknown",
      updatedAt: schedule.lastRunAt,
    };
  }

  if (config.mock) {
    return {
      id: `${schedule.id}-last-run`,
      workflowId: String(schedule.workflowId),
      workflowName: schedule.workflowName,
      ref: schedule.ref,
      status: schedule.lastStatus === "failed" ? "completed" : schedule.lastStatus,
      conclusion: schedule.lastStatus === "failed" ? "failure" : schedule.lastStatus,
      htmlUrl: `https://github.com/${schedule.repoKey}/actions/runs/${encodeURIComponent(schedule.id)}`,
      updatedAt: schedule.lastRunAt || new Date().toISOString(),
      mock: true,
    };
  }

  const repo = getRepoByKey(schedule.repoKey);
  if (!config.token || !repo) return null;

  try {
    const response = await githubFetch(
      repo,
      `/repos/${repo.owner}/${repo.repo}/actions/workflows/${encodeURIComponent(schedule.workflowId)}/runs?branch=${encodeURIComponent(schedule.ref || "")}&per_page=1`,
    );
    if (!response.ok) return null;

    const data = await response.json();
    const run = data.workflow_runs?.[0];
    return run ? normalizeRun(repo.key, schedule.workflowId, run) : null;
  } catch {
    return null;
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function computeNextRun(schedule, fromDate) {
  const fields = parseCron(schedule.cron);
  fields.timezone = schedule.timezone || "";
  const cursor = new Date(fromDate);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const maxSearchMinutes = 366 * 24 * 60;
  for (let i = 0; i < maxSearchMinutes; i += 1) {
    if (cronMatchesDate(fields, cursor)) return cursor.toISOString();
    cursor.setMinutes(cursor.getMinutes() + 1);
  }

  throw httpError(400, "No matching run time found within one year");
}

function validateCron(expression) {
  parseCron(expression);
}

function parseCron(expression) {
  const parts = String(expression || "").trim().split(/\s+/);
  if (parts.length !== 5) {
    throw httpError(400, "Cron expression must have five fields: minute hour day-of-month month day-of-week");
  }

  return {
    minute: parseCronField(parts[0], 0, 59, "minute"),
    hour: parseCronField(parts[1], 0, 23, "hour"),
    dayOfMonth: parseCronField(parts[2], 1, 31, "day-of-month"),
    month: parseCronField(parts[3], 1, 12, "month"),
    dayOfWeek: parseCronField(parts[4], 0, 7, "day-of-week", { normalizeSevenToZero: true }),
  };
}

function parseCronField(field, min, max, name, options = {}) {
  const values = new Set();
  const wildcard = field === "*" || field.startsWith("*/");

  for (const segment of field.split(",")) {
    if (!segment) throw httpError(400, `Invalid ${name} field`);

    const [rangePart, stepPart] = segment.split("/");
    if (segment.split("/").length > 2) throw httpError(400, `Invalid ${name} step`);

    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw httpError(400, `Invalid ${name} step`);

    let start;
    let end;

    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const [rawStart, rawEnd] = rangePart.split("-").map(Number);
      start = rawStart;
      end = rawEnd;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) {
        throw httpError(400, `Invalid ${name} range`);
      }
    } else {
      start = Number(rangePart);
      end = start;
      if (!Number.isInteger(start)) throw httpError(400, `Invalid ${name} value`);
    }

    if (start < min || end > max) throw httpError(400, `${name} value out of range`);

    for (let value = start; value <= end; value += step) {
      values.add(options.normalizeSevenToZero && value === 7 ? 0 : value);
    }
  }

  return { values, wildcard };
}

function cronMatchesDate(fields, date) {
  const parts = getDateParts(date, fields.timezone);
  const dayOfMonthMatches = fields.dayOfMonth.values.has(parts.day);
  const dayOfWeekMatches = fields.dayOfWeek.values.has(parts.dayOfWeek);
  const dayMatches =
    fields.dayOfMonth.wildcard || fields.dayOfWeek.wildcard
      ? dayOfMonthMatches && dayOfWeekMatches
      : dayOfMonthMatches || dayOfWeekMatches;

  return (
    fields.minute.values.has(parts.minute) &&
    fields.hour.values.has(parts.hour) &&
    fields.month.values.has(parts.month) &&
    dayMatches
  );
}

function getDateParts(date, timezone) {
  if (!timezone) {
    return {
      month: date.getMonth() + 1,
      day: date.getDate(),
      dayOfWeek: date.getDay(),
      hour: date.getHours(),
      minute: date.getMinutes(),
    };
  }

  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    });
    const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, Number(part.value)]));
    return {
      month: parts.month,
      day: parts.day,
      dayOfWeek: new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay(),
      hour: parts.hour,
      minute: parts.minute,
    };
  } catch {
    return getDateParts(date, "");
  }
}

async function readScheduleStates() {
  try {
    const raw = await readFile(schedulesFile, "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return data;
    return Object.fromEntries(
      data.map((schedule) => [
        schedule.id,
        {
          lastRunAt: schedule.lastRunAt || null,
          lastStatus: schedule.lastStatus || "never",
          lastError: schedule.lastError || "",
          lastRunUrl: schedule.lastRunUrl || "",
        },
      ]),
    );
  } catch {
    return {};
  }
}

function updateScheduleState(scheduleId, patch) {
  scheduleStates[scheduleId] = {
    ...(scheduleStates[scheduleId] || {}),
    ...patch,
  };
}

async function saveScheduleStates() {
  await mkdir(dataDir, { recursive: true });
  await writeFile(schedulesFile, JSON.stringify(scheduleStates, null, 2));
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function parseRepos(value, owner, repo) {
  const repoValues = value
    ? value.split(",").map((item) => item.trim()).filter(Boolean)
    : owner && repo
      ? [`${owner}/${repo}`]
      : [];

  return repoValues.map((repoValue) => {
    const [repoOwner, repoName] = repoValue.split("/");
    if (!repoOwner || !repoName) throw new Error(`Invalid repo "${repoValue}". Use owner/repo.`);
    return { owner: repoOwner, repo: repoName, key: `${repoOwner}/${repoName}` };
  });
}

function getRepoFromRequest(url) {
  return getRepoByKey(url.searchParams.get("repo"), { fallback: true });
}

function shouldForceRefresh(url) {
  return url.searchParams.get("refresh") === "1";
}

function getRepoFromBody(body) {
  return getRepoByKey(body.repoKey || body.repo, { fallback: true });
}

function getDefaultRepo() {
  return config.repos[0];
}

function getRepoByKey(repoKey, options = {}) {
  const repo = config.repos.find((item) => item.key === repoKey);
  if (repo) return repo;
  if (options.fallback && config.repos[0]) return config.repos[0];
  throw httpError(400, "Unknown repository");
}

function getRunKey(repoKey, workflowId) {
  return `${repoKey}:${workflowId}`;
}

function encodeURIComponentPath(pathname) {
  return pathname.split("/").map(encodeURIComponent).join("/");
}

async function githubFetch(repo, pathname, options = {}) {
  return fetch(`https://api.github.com${pathname}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
      "User-Agent": "github-actions-scheduler",
      "X-GitHub-Api-Version": "2022-11-28",
      ...options.headers,
    },
  });
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function loadDotEnv() {
  try {
    const raw = readFileSync(join(__dirname, ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index === -1) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // Optional local configuration.
  }
}
