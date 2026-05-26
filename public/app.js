const state = {
  config: null,
  schedules: [],
};

const elements = {
  refreshButton: document.querySelector("#refreshButton"),
  scheduleList: document.querySelector("#scheduleList"),
  scheduleCount: document.querySelector("#scheduleCount"),
  statusBanner: document.querySelector("#statusBanner"),
  scheduleTemplate: document.querySelector("#scheduleTemplate"),
};

elements.refreshButton.addEventListener("click", () => loadAll({ refresh: true }));
loadAll();
setInterval(loadAll, 30_000);

async function loadAll(options = {}) {
  setRefreshing(true);
  showStatus("");

  try {
    state.config = await api("/api/config");
    state.schedules = await loadSchedules(options.refresh);
    renderSchedules();
  } catch (error) {
    showStatus(error.message);
  } finally {
    setRefreshing(false);
  }
}

async function loadSchedules(refresh = false) {
  const repos = state.config?.repos || [];
  const query = refresh ? "&refresh=1" : "";
  const results = await Promise.all(
    repos.map(async (repo) => {
      try {
        const data = await api(`/api/schedules?repo=${encodeURIComponent(repo.key)}${query}`);
        return data.schedules || [];
      } catch (error) {
        return [repoImportFailure(repo, error)];
      }
    }),
  );

  return results.flat().sort((a, b) => Number(Boolean(b.importFailed)) - Number(Boolean(a.importFailed)));
}

function renderSchedules() {
  const repoCount = state.config?.repos?.length || 0;
  elements.scheduleCount.textContent = `${state.schedules.length} workflows · ${repoCount} repos`;
  elements.scheduleList.replaceChildren();

  if (!state.schedules.length) {
    elements.scheduleList.append(emptyState("No schedules yet."));
    return;
  }

  for (const schedule of state.schedules) {
    elements.scheduleList.append(renderSchedule(schedule));
  }
}

function renderSchedule(schedule) {
  const node = elements.scheduleTemplate.content.firstElementChild.cloneNode(true);
  node.classList.toggle("is-import-failed", Boolean(schedule.importFailed));

  const title = node.querySelector("h3");
  const titleElement = document.createElement(schedule.githubUrl ? "a" : "span");
  titleElement.textContent = `${schedule.repoKey} · ${schedule.workflowName}`;

  if (schedule.githubUrl) {
    titleElement.href = schedule.githubUrl;
    titleElement.target = "_blank";
    titleElement.rel = "noreferrer";
    titleElement.title = "Open latest GitHub Actions run";
  }

  title.replaceChildren(titleElement);

  const meta = node.querySelector(".schedule-meta");
  const status = node.querySelector(".schedule-status");

  if (schedule.importFailed) {
    meta.textContent = `${schedule.workflowPath} · failed import`;
    status.textContent = schedule.lastError || "Failed to parse @external-schedule block";
    status.classList.add("is-failed");
    status.title = status.textContent;
    return node;
  }

  meta.textContent = `${schedule.cron} · ${schedule.timezone || "server timezone"} · ref ${schedule.ref} · next ${formatDate(schedule.nextRunAt)}`;
  status.textContent = schedule.lastRunAt ? `Last run ${formatDate(schedule.lastRunAt)} · ${schedule.lastStatus}` : "Not run yet";
  status.classList.toggle("is-success", schedule.lastStatus === "success");
  status.classList.toggle("is-failed", schedule.lastStatus === "failed");
  if (schedule.lastError) status.title = schedule.lastError;

  return node;
}

function emptyState(text) {
  const element = document.createElement("div");
  element.className = "empty";
  element.textContent = text;
  return element;
}

function repoImportFailure(repo, error) {
  return {
    id: `${repo?.key || "unknown"}:repo-import-failed`,
    importFailed: true,
    repoKey: repo?.key || "unknown repository",
    workflowName: "Repository scan failed",
    workflowPath: repo?.key || "",
    lastError: error?.message || "Failed to scan repository schedules",
  };
}

function setRefreshing(isRefreshing) {
  elements.refreshButton.disabled = isRefreshing;
  elements.refreshButton.classList.toggle("is-loading", isRefreshing);
  elements.refreshButton.title = isRefreshing ? "Scanning workflows" : "Refresh workflows";
  elements.refreshButton.setAttribute("aria-label", elements.refreshButton.title);
}

function showStatus(message) {
  elements.statusBanner.hidden = !message;
  elements.statusBanner.textContent = message;
}

function formatDate(value) {
  if (!value) return "not scheduled";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

async function api(path) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" } });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
