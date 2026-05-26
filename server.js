import { createServer } from "node:http";
import { createReadStream, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = resolve(__dirname, "public");
const dataDir = resolve(__dirname, "data");
const stateFile = join(dataDir, "schedules.json");

loadDotEnv();

const config = {
  token: process.env.GITHUB_TOKEN || "",
  repos: parseRepos(process.env.GITHUB_REPOS, process.env.GITHUB_OWNER, process.env.GITHUB_REPO),
  port: Number(process.env.PORT || 4173),
  host: process.env.HOST || "127.0.0.1",
  mock: process.env.MOCK_DATA === "true",
};

config.mock = config.mock || !config.token || !config.repos.length;
if (config.mock) {
  config.repos = [{ owner: "local", repo: "scheduler", key: "local/scheduler" }];
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

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(res, url);
  } catch (error) {
    console.error(error);
    sendJson(res, error.status || 500, { error: error.message || "Internal server error" });
  }
}).listen(config.port, config.host, () => {
  console.log(`GitHub Actions Scheduler running at http://${config.host}:${config.port}`);
  console.log(config.mock ? "Using mock GitHub data." : `Repositories: ${config.repos.map((repo) => repo.key).join(", ")}`);
});

setInterval(runDueSchedules, 30_000);
setInterval(refreshActiveRuns, 10_000);
refreshWorkflowCaches();

async function handleApi(req, res, url) {
  if (req.method !== "GET") throw httpError(405, "Method not allowed");

  if (url.pathname === "/api/config") {
    sendJson(res, 200, {
      configured: Boolean(config.token && config.repos.length),
      mock: config.mock,
      repos: config.repos,
      hasToken: Boolean(config.token),
    });
    return;
  }

  if (url.pathname === "/api/schedules") {
    const repo = getRepo(url.searchParams.get("repo"));
    const schedules = await getSchedules(repo, url.searchParams.get("refresh") === "1");
    sendJson(res, 200, { schedules: await Promise.all(schedules.map(addLatestRunLink)) });
    return;
  }

  if (url.pathname === "/api/runs") {
    await refreshActiveRuns();
    const repo = getRepo(url.searchParams.get("repo"));
    sendJson(res, 200, { runs: [...activeRuns.values()].filter((run) => run.repoKey === repo.key) });
    return;
  }

  throw httpError(404, "Not found");
}

async function serveStatic(res, url) {
  const requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = resolve(publicDir, `.${normalize(requestedPath)}`);

  if (!filePath.startsWith(publicDir)) throw httpError(403, "Forbidden");

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

async function refreshWorkflowCaches(force = false) {
  await Promise.all(config.repos.map((repo) => refreshWorkflowCache(repo, force)));
}

async function refreshWorkflowCache(repo, force = false) {
  const cached = workflowCaches.get(repo.key);
  if (!force && cached && Date.now() - Date.parse(cached.fetchedAt) < 30_000) return cached;

  try {
    const workflows = config.mock ? await getLocalWorkflows(repo) : await getGitHubWorkflows(repo);
    await attachSchedules(repo, workflows);
    const cache = { repoKey: repo.key, workflows, fetchedAt: new Date().toISOString(), error: null, mock: config.mock };
    workflowCaches.set(repo.key, cache);
    return cache;
  } catch (error) {
    const cache = { repoKey: repo.key, workflows: [], fetchedAt: new Date().toISOString(), error: error.message };
    workflowCaches.set(repo.key, cache);
    return cache;
  }
}

async function getGitHubWorkflows(repo) {
  const response = await githubFetch(repo, `/repos/${repo.owner}/${repo.repo}/actions/workflows`);
  if (!response.ok) throw httpError(response.status, await response.text());
  const data = await response.json();
  return (data.workflows || []).map((workflow) => ({
    id: workflow.id,
    name: workflow.name,
    path: workflow.path,
    state: workflow.state,
    htmlUrl: workflow.html_url,
    updatedAt: workflow.updated_at,
  }));
}

async function getLocalWorkflows(repo) {
  const workflowDir = join(__dirname, ".github", "workflows");
  let files = [];
  try {
    files = await readdir(workflowDir);
  } catch {
    return [];
  }

  return Promise.all(
    files.filter((file) => /\.ya?ml$/i.test(file)).sort().map(async (file) => {
      const path = `.github/workflows/${file}`;
      const content = await readFile(join(__dirname, path), "utf8");
      return {
        id: `${repo.key.replace("/", "-")}-${file.replace(/[^A-Za-z0-9_-]/g, "-")}`,
        name: getWorkflowName(content) || file,
        path,
        state: "active",
        htmlUrl: `https://github.com/${repo.key}/actions/workflows/${encodeURIComponent(file)}`,
        updatedAt: new Date().toISOString(),
      };
    }),
  );
}

async function attachSchedules(repo, workflows) {
  await Promise.all(workflows.map(async (workflow) => {
    try {
      const content = await readWorkflowFile(repo, workflow);
      workflow.externalSchedules = parseScheduleDefinitions(content).map((definition, index) => {
        const schedule = buildSchedule(repo, workflow, definition, index);
        return mergeScheduleState(schedule);
      });
    } catch (error) {
      workflow.externalSchedules = [buildImportFailure(repo, workflow, error)];
    }
  }));
}

async function getSchedules(repo, force = false) {
  const cache = await refreshWorkflowCache(repo, force);
  return cache.workflows.flatMap((workflow) => workflow.externalSchedules || []);
}

async function readWorkflowFile(repo, workflow) {
  if (config.mock) return readFile(join(__dirname, workflow.path), "utf8");

  const response = await githubFetch(repo, `/repos/${repo.owner}/${repo.repo}/contents/${encodePath(workflow.path)}`, {
    headers: { Accept: "application/vnd.github.raw+json" },
  });

  return response.ok ? response.text() : "";
}

function parseScheduleDefinitions(content) {
  const lines = content.split(/\r?\n/);
  const marker = lines.findIndex((line) => /^\s*#\s*@external-schedule:\s*$/.test(line));
  if (marker === -1) return [];

  const block = [];
  for (const line of lines.slice(marker + 1)) {
    if (!line.trim()) continue;
    if (!line.trimStart().startsWith("#")) break;
    block.push(line.replace(/^\s*# ?/, ""));
  }

  const parsed = parseScheduleBlock(block);
  if (parsed.enabled === false) return [];
  if (!parsed.schedule.length) throw new Error("@external-schedule must contain at least one schedule item with cron");

  return parsed.schedule.map((item) => ({
    enabled: item.enabled ?? parsed.enabled ?? true,
    timezone: item.timezone || parsed.timezone || "",
    ref: parsed.ref || "main",
    inputs: { ...(parsed.inputs || {}), ...(item.inputs || {}) },
    cron: item.cron,
  }));
}

function parseScheduleBlock(lines) {
  const root = { enabled: true, schedule: [], inputs: {} };
  let currentItem = null;
  let inputTarget = null;

  for (const line of lines) {
    if (!line.trim()) continue;

    const topLevel = line.match(/^ {2}([A-Za-z0-9_-]+):\s*(.*)$/);
    if (topLevel) {
      const [, key, rawValue] = topLevel;
      inputTarget = null;
      if (key === "schedule") continue;
      if (key === "inputs") {
        inputTarget = root.inputs;
        continue;
      }
      root[key] = parseScalar(rawValue);
      continue;
    }

    const itemStart = line.match(/^ {4}-\s*cron:\s*(.*)$/);
    if (itemStart) {
      currentItem = { cron: parseScalar(itemStart[1]), inputs: {} };
      root.schedule.push(currentItem);
      inputTarget = null;
      continue;
    }

    const itemField = line.match(/^ {6}([A-Za-z0-9_-]+):\s*(.*)$/);
    if (itemField && currentItem) {
      const [, key, rawValue] = itemField;
      if (key === "ref") throw new Error("Per-schedule ref is not allowed; define ref at the top level");
      if (key === "inputs") {
        inputTarget = currentItem.inputs;
        continue;
      }
      currentItem[key] = parseScalar(rawValue);
      inputTarget = null;
      continue;
    }

    const inputField = line.match(/^ {4,8}([A-Za-z0-9_-]+):\s*(.*)$/);
    if (inputField && inputTarget) {
      inputTarget[inputField[1]] = parseScalar(inputField[2]);
      continue;
    }

    throw new Error(`Could not parse @external-schedule line: "${line.trim()}"`);
  }

  root.schedule = root.schedule.filter((item) => item.cron);
  return root;
}

function buildSchedule(repo, workflow, definition, index) {
  validateCron(definition.cron);
  const id = `${repo.key}:${workflow.id}:${index}:${definition.cron}`;
  return {
    id,
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
    nextRunAt: computeNextRun(definition, new Date()),
  };
}

function buildImportFailure(repo, workflow, error) {
  return {
    id: `${repo.key}:${workflow.id}:import-failed`,
    importFailed: true,
    repoKey: repo.key,
    owner: repo.owner,
    repo: repo.repo,
    workflowId: String(workflow.id),
    workflowName: workflow.name,
    workflowPath: workflow.path,
    workflowHtmlUrl: workflow.htmlUrl || "",
    enabled: false,
    nextRunAt: null,
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

async function runDueSchedules() {
  const dueSchedules = (await Promise.all(config.repos.map((repo) => getSchedules(repo)))).flat()
    .filter((schedule) => schedule.enabled && schedule.nextRunAt && Date.parse(schedule.nextRunAt) <= Date.now());

  if (!dueSchedules.length) return;

  for (const schedule of dueSchedules) {
    try {
      const repo = getRepo(schedule.repoKey);
      const run = await dispatchWorkflow(repo, schedule);
      updateScheduleState(schedule.id, {
        lastRunAt: new Date().toISOString(),
        lastStatus: "success",
        lastError: "",
        lastRunUrl: run?.htmlUrl || "",
      });
    } catch (error) {
      updateScheduleState(schedule.id, {
        lastRunAt: new Date().toISOString(),
        lastStatus: "failed",
        lastError: error.message || "Dispatch failed",
      });
    }
  }

  await saveScheduleStates();
}

async function dispatchWorkflow(repo, schedule) {
  const runKey = getRunKey(repo.key, schedule.workflowId);
  const existingRun = activeRuns.get(runKey);
  if (isRunActive(existingRun)) throw httpError(409, `${existingRun.workflowName || "Workflow"} is already ${existingRun.status}`);

  if (config.mock) {
    const run = {
      id: `mock-run-${Date.now()}`,
      repoKey: repo.key,
      workflowId: schedule.workflowId,
      workflowName: schedule.workflowName,
      ref: schedule.ref,
      status: "in_progress",
      conclusion: null,
      htmlUrl: `https://github.com/${repo.key}/actions/runs/${Date.now()}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completesAt: new Date(Date.now() + 60_000).toISOString(),
      mock: true,
    };
    activeRuns.set(runKey, run);
    return run;
  }

  const dispatchedAfter = new Date(Date.now() - 10_000).toISOString();
  const response = await githubFetch(repo, `/repos/${repo.owner}/${repo.repo}/actions/workflows/${encodeURIComponent(schedule.workflowId)}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: schedule.ref || "main", inputs: schedule.inputs || {} }),
  });
  if (!response.ok) throw httpError(response.status, await response.text());

  const run = await findDispatchedRun(repo, schedule, dispatchedAfter);
  activeRuns.set(runKey, run);
  return run;
}

async function refreshActiveRuns() {
  for (const [runKey, run] of activeRuns) {
    if (config.mock) {
      if (run.completesAt && Date.parse(run.completesAt) <= Date.now()) {
        activeRuns.set(runKey, { ...run, status: "completed", conclusion: "success", updatedAt: new Date().toISOString() });
      }
      continue;
    }

    if (!isRunActive(run)) continue;
    try {
      const repo = getRepo(run.repoKey);
      const updatedRun = await getWorkflowRun(repo, run.id);
      if (updatedRun) activeRuns.set(runKey, updatedRun);
    } catch (error) {
      activeRuns.set(runKey, { ...run, status: "unknown", conclusion: "error", error: error.message, updatedAt: new Date().toISOString() });
    }
  }
}

async function findDispatchedRun(repo, schedule, dispatchedAfter) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (attempt) await delay(2_000);
    const run = await findLatestRun(repo, schedule.workflowId, schedule.ref, dispatchedAfter);
    if (run) return run;
  }

  return {
    id: null,
    repoKey: repo.key,
    workflowId: schedule.workflowId,
    workflowName: schedule.workflowName,
    ref: schedule.ref,
    status: "queued",
    conclusion: null,
    htmlUrl: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function findLatestRun(repo, workflowId, ref, after) {
  const response = await githubFetch(repo, `/repos/${repo.owner}/${repo.repo}/actions/workflows/${encodeURIComponent(workflowId)}/runs?branch=${encodeURIComponent(ref || "")}&per_page=10`);
  if (!response.ok) throw httpError(response.status, await response.text());

  const data = await response.json();
  const run = (data.workflow_runs || []).find((item) => !after || new Date(item.created_at) >= new Date(after));
  return run ? normalizeRun(repo.key, workflowId, run) : null;
}

async function getWorkflowRun(repo, runId) {
  if (!runId) return null;
  const response = await githubFetch(repo, `/repos/${repo.owner}/${repo.repo}/actions/runs/${encodeURIComponent(runId)}`);
  if (!response.ok) throw httpError(response.status, await response.text());
  const run = await response.json();
  return normalizeRun(repo.key, run.workflow_id, run);
}

async function addLatestRunLink(schedule) {
  if (schedule.importFailed) return { ...schedule, githubUrl: "", latestRun: null };

  const activeRun = activeRuns.get(getRunKey(schedule.repoKey, schedule.workflowId));
  if (activeRun?.htmlUrl && (!schedule.ref || activeRun.ref === schedule.ref)) {
    return { ...schedule, latestRun: activeRun, githubUrl: activeRun.htmlUrl };
  }

  if (schedule.lastRunUrl) {
    const latestRun = { htmlUrl: schedule.lastRunUrl, status: schedule.lastStatus || "unknown", updatedAt: schedule.lastRunAt };
    return { ...schedule, latestRun, githubUrl: latestRun.htmlUrl };
  }

  if (config.mock) {
    const latestRun = {
      htmlUrl: `https://github.com/${schedule.repoKey}/actions/runs/${encodeURIComponent(schedule.id)}`,
      status: schedule.lastStatus || "never",
      updatedAt: schedule.lastRunAt || new Date().toISOString(),
      mock: true,
    };
    return { ...schedule, latestRun, githubUrl: latestRun.htmlUrl };
  }

  try {
    const repo = getRepo(schedule.repoKey);
    const latestRun = await findLatestRun(repo, schedule.workflowId, schedule.ref);
    return { ...schedule, latestRun, githubUrl: latestRun?.htmlUrl || "" };
  } catch {
    return { ...schedule, latestRun: null, githubUrl: "" };
  }
}

function normalizeRun(repoKey, workflowId, run) {
  return {
    id: run.id,
    repoKey,
    workflowId: String(workflowId),
    workflowName: run.name || `Workflow ${workflowId}`,
    ref: run.head_branch || "",
    status: run.status,
    conclusion: run.conclusion,
    htmlUrl: run.html_url,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
  };
}

function computeNextRun(schedule, fromDate) {
  const fields = parseCron(schedule.cron);
  fields.timezone = schedule.timezone || "";

  const cursor = new Date(fromDate);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  for (let i = 0; i < 366 * 24 * 60; i += 1) {
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
  if (parts.length !== 5) throw httpError(400, "Cron expression must have five fields");

  return {
    minute: parseCronField(parts[0], 0, 59, "minute"),
    hour: parseCronField(parts[1], 0, 23, "hour"),
    dayOfMonth: parseCronField(parts[2], 1, 31, "day-of-month"),
    month: parseCronField(parts[3], 1, 12, "month"),
    dayOfWeek: parseCronField(parts[4], 0, 7, "day-of-week", true),
  };
}

function parseCronField(field, min, max, name, normalizeSevenToZero = false) {
  const values = new Set();
  const wildcard = field === "*" || field.startsWith("*/");

  for (const segment of field.split(",")) {
    const [rangePart, stepPart] = segment.split("/");
    if (!rangePart || segment.split("/").length > 2) throw httpError(400, `Invalid ${name} field`);

    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw httpError(400, `Invalid ${name} step`);

    let start;
    let end;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      [start, end] = rangePart.split("-").map(Number);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) throw httpError(400, `Invalid ${name} range`);
    } else {
      start = Number(rangePart);
      end = start;
      if (!Number.isInteger(start)) throw httpError(400, `Invalid ${name} value`);
    }

    if (start < min || end > max) throw httpError(400, `${name} value out of range`);
    for (let value = start; value <= end; value += step) {
      values.add(normalizeSevenToZero && value === 7 ? 0 : value);
    }
  }

  return { values, wildcard };
}

function cronMatchesDate(fields, date) {
  const parts = getDateParts(date, fields.timezone);
  const dayOfMonthMatches = fields.dayOfMonth.values.has(parts.day);
  const dayOfWeekMatches = fields.dayOfWeek.values.has(parts.dayOfWeek);
  const dayMatches = fields.dayOfMonth.wildcard || fields.dayOfWeek.wildcard
    ? dayOfMonthMatches && dayOfWeekMatches
    : dayOfMonthMatches || dayOfWeekMatches;

  return fields.minute.values.has(parts.minute)
    && fields.hour.values.has(parts.hour)
    && fields.month.values.has(parts.month)
    && dayMatches;
}

function getDateParts(date, timezone) {
  if (!timezone) {
    return { month: date.getMonth() + 1, day: date.getDate(), dayOfWeek: date.getDay(), hour: date.getHours(), minute: date.getMinutes() };
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
    return { month: parts.month, day: parts.day, dayOfWeek: new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay(), hour: parts.hour, minute: parts.minute };
  } catch {
    return getDateParts(date, "");
  }
}

async function readScheduleStates() {
  try {
    const data = JSON.parse(await readFile(stateFile, "utf8"));
    if (!Array.isArray(data)) return data;

    return Object.fromEntries(data.map((schedule) => [schedule.id, {
      lastRunAt: schedule.lastRunAt || null,
      lastStatus: schedule.lastStatus || "never",
      lastError: schedule.lastError || "",
      lastRunUrl: schedule.lastRunUrl || "",
    }]));
  } catch {
    return {};
  }
}

function updateScheduleState(scheduleId, patch) {
  scheduleStates[scheduleId] = { ...(scheduleStates[scheduleId] || {}), ...patch };
}

async function saveScheduleStates() {
  await mkdir(dataDir, { recursive: true });
  await writeFile(stateFile, JSON.stringify(scheduleStates, null, 2));
}

function parseRepos(value, owner, repo) {
  const repoValues = value ? value.split(",").map((item) => item.trim()).filter(Boolean) : owner && repo ? [`${owner}/${repo}`] : [];
  return repoValues.map((repoValue) => {
    const [repoOwner, repoName] = repoValue.split("/");
    if (!repoOwner || !repoName) throw new Error(`Invalid repo "${repoValue}". Use owner/repo.`);
    return { owner: repoOwner, repo: repoName, key: `${repoOwner}/${repoName}` };
  });
}

function getRepo(repoKey) {
  const repo = config.repos.find((item) => item.key === repoKey) || config.repos[0];
  if (!repo) throw httpError(400, "Unknown repository");
  return repo;
}

function getWorkflowName(content) {
  const match = content.match(/^name:\s*(.+)$/m);
  return match ? parseScalar(match[1]) : "";
}

function parseScalar(value) {
  const trimmed = String(value || "").trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return trimmed.replace(/^["']|["']$/g, "");
}

function isRunActive(run) {
  return Boolean(run && ["queued", "in_progress", "waiting", "requested", "pending"].includes(run.status));
}

function getRunKey(repoKey, workflowId) {
  return `${repoKey}:${workflowId}`;
}

function encodePath(pathname) {
  return pathname.split("/").map(encodeURIComponent).join("/");
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
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

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
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
