const state = {
  workflows: [],
  schedules: [],
  runs: [],
  config: null,
};

const elements = {
  refreshButton: document.querySelector("#refreshButton"),
  scheduleList: document.querySelector("#scheduleList"),
  scheduleCount: document.querySelector("#scheduleCount"),
  statusBanner: document.querySelector("#statusBanner"),
  scheduleTemplate: document.querySelector("#scheduleTemplate"),
};

elements.refreshButton.addEventListener("click", () => loadAll({ force: true }));

loadAll();
setInterval(loadSchedules, 30_000);
setInterval(loadRuns, 10_000);

async function loadAll(options = {}) {
  setRefreshing(true);
  try {
    await loadConfig();
    await Promise.all([loadSchedules({ force: options.force }), loadRuns()]);
    render();
  } catch (error) {
    showStatus(error.message);
  } finally {
    setRefreshing(false);
  }
}

async function loadConfig() {
  state.config = await api("/api/config");
}

async function loadSchedules(options = {}) {
  const repos = state.config?.repos || [];
  const refresh = options.force ? "&refresh=1" : "";
  const results = await Promise.all(
    repos.map((repo) =>
      api(`/api/schedules?repo=${encodeURIComponent(repo.key)}${refresh}`)
        .then((result) => ({ repo, result }))
        .catch((error) => ({ repo, error })),
    ),
  );
  state.schedules = results.flatMap((item) => {
    if (!item.error) return item.result.schedules || [];
    return [repoImportFailure(item.repo, item.error)];
  });
  renderSchedules();
}

async function loadRuns() {
  const repos = state.config?.repos || [];
  const results = await Promise.allSettled(repos.map((repo) => api(`/api/runs?repo=${encodeURIComponent(repo.key)}`)));
  state.runs = results.flatMap((item) => (item.status === "fulfilled" ? item.value.runs || [] : []));
}

function render() {
  renderSchedules();
}

function renderSchedules() {
  const repoCount = state.config?.repos?.length || 0;
  elements.scheduleCount.textContent = `${state.schedules.length} workflows · ${repoCount} repos`;
  elements.scheduleList.replaceChildren();

  if (!state.schedules.length) {
    elements.scheduleList.append(emptyState("No schedules yet."));
    return;
  }

  const schedules = [...state.schedules].sort((a, b) => Number(Boolean(b.importFailed)) - Number(Boolean(a.importFailed)));

  for (const schedule of schedules) {
    const node = elements.scheduleTemplate.content.firstElementChild.cloneNode(true);
    node.classList.toggle("is-import-failed", Boolean(schedule.importFailed));
    const title = node.querySelector("h3");
    const titleLink = document.createElement(schedule.githubUrl ? "a" : "span");
    titleLink.textContent = `${schedule.repoKey} · ${schedule.workflowName}`;
    if (schedule.githubUrl) {
      titleLink.href = schedule.githubUrl;
      titleLink.target = "_blank";
      titleLink.rel = "noreferrer";
      titleLink.title = "Open latest GitHub Actions run";
    }
    title.replaceChildren(titleLink);

    const status = node.querySelector(".schedule-status");
    if (schedule.importFailed) {
      node.querySelector(".schedule-meta").textContent = `${schedule.workflowPath} · failed import`;
      status.textContent = schedule.lastError || "Failed to parse @external-schedule block";
      status.classList.add("is-failed");
      status.title = status.textContent;
    } else {
      node.querySelector(".schedule-meta").textContent =
        `${schedule.cron} · ${schedule.timezone || "server timezone"} · ref ${schedule.ref} · next ${formatDate(schedule.nextRunAt)}`;
      status.textContent = schedule.lastRunAt ? `Last run ${formatDate(schedule.lastRunAt)} · ${schedule.lastStatus}` : "Not run yet";
      status.classList.toggle("is-success", schedule.lastStatus === "success");
      status.classList.toggle("is-failed", schedule.lastStatus === "failed");
      if (schedule.lastError) status.title = schedule.lastError;
    }
    elements.scheduleList.append(node);
  }
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
  elements.refreshButton.setAttribute("aria-label", isRefreshing ? "Scanning workflows" : "Refresh workflows");
}

function showStatus(message, tone = "warn") {
  elements.statusBanner.hidden = !message;
  elements.statusBanner.textContent = message;
  elements.statusBanner.style.borderColor = tone === "success" ? "#9ad6b9" : "";
  elements.statusBanner.style.background = tone === "success" ? "#ecfdf3" : "";
  elements.statusBanner.style.color = tone === "success" ? "#067647" : "";
}

function formatDate(value) {
  if (!value) return "not scheduled";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}
