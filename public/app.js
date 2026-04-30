const state = {
  token: localStorage.getItem("cpamc_sidecar_token") || "",
  user: null,
  view: "dashboard",
  loading: false,
  error: "",
  range: { preset: "24h", from: "", to: "" },
  usage: null,
  aliases: {},
  models: [],
  users: [],
  backups: [],
  snapshots: [],
  audit: [],
  status: null,
  settings: null,
  insights: null,
  sessions: [],
  report: null,
  language: localStorage.getItem("cpamc_language") || "auto",
  theme: localStorage.getItem("cpamc_theme") || "",
  fullscreen: false,
  alerts: [],
  alertUsers: [],
  groups: [],
  search: "",
  sort: "tokens",
  page: 1,
  drawer: null,
};

const app = document.querySelector("#app");
const chartRegistry = [];

const DEFAULT_SETTINGS = {
  appearance: {
    appName: "CPAMC Sidecar",
    logoText: "C",
    defaultTheme: "tech-dark",
    defaultLanguage: "auto",
    density: "comfortable",
    radius: 8,
    customTheme: {
      primary: "#20c788",
      accent: "#5fa8ff",
    },
  },
  permissions: {
    allowViewerExport: true,
  },
  pricing: {
    currency: "USD",
    models: {},
  },
  notifications: {
    webhookEnabled: false,
    webhookUrl: "",
    dailyReportEnabled: false,
    dailyReportHour: 9,
    anomalyEnabled: true,
  },
  automation: {
    autoDisableOnLimitExceeded: false,
  },
};

const DICT = {
  zh: {
    loginTitle: "API Key 登录",
    loginHint: "使用 CPAMC 生成的 API Key 登录。管理员可以查看全部 Key，普通用户只看到自己的用量。",
    login: "登录",
    logout: "退出",
    refresh: "刷新",
    loading: "正在加载数据...",
    dashboard: "仪表盘",
    models: "模型",
    insights: "洞察",
    users: "用户",
    alerts: "限额",
    backups: "备份",
    snapshots: "快照",
    sessions: "会话",
    health: "服务器",
    audit: "审计",
    settings: "设置",
    profile: "资料",
    bigScreen: "大屏",
    exitScreen: "退出大屏",
  },
  en: {
    loginTitle: "API Key Login",
    loginHint: "Sign in with a CPAMC API key. Admins see all keys; users only see their own usage.",
    login: "Login",
    logout: "Logout",
    refresh: "Refresh",
    loading: "Loading...",
    dashboard: "Dashboard",
    models: "Models",
    insights: "Insights",
    users: "Users",
    alerts: "Limits",
    backups: "Backups",
    snapshots: "Snapshots",
    sessions: "Sessions",
    health: "Server",
    audit: "Audit",
    settings: "Settings",
    profile: "Profile",
    bigScreen: "Board",
    exitScreen: "Exit board",
  },
};

render();
bootstrap();

async function bootstrap() {
  if (!state.token) return;
  try {
    const me = await api("/api/me");
    state.user = me.user;
    state.settings = me.settings || null;
    applyAppearance();
    await refreshAll();
  } catch {
    logout(false);
  }
}

async function refreshAll() {
  state.loading = true;
  state.error = "";
  render();
  try {
    await loadUsage();
    if (state.view === "models") await loadModels();
    if (state.user && canAdminViewer()) {
      if (state.view === "dashboard") await loadAlertsAndGroups().catch(() => {});
      if (state.view === "insights") await loadInsights();
      if (state.view === "sessions") await loadSessions();
    }
    if (state.user && state.user.role === "admin") {
      if (state.view === "users") await loadUsers();
      if (state.view === "backups") await loadBackups();
      if (state.view === "snapshots") await loadSnapshots();
      if (state.view === "alerts") await loadAlertsAndGroups();
      if (state.view === "audit") await loadAudit();
      if (state.view === "health") await loadStatus();
      if (state.view === "settings") await loadSettings();
    }
  } catch (err) {
    state.error = err.message;
  } finally {
    state.loading = false;
    render();
  }
}

async function loadUsage() {
  const result = await api(`/api/usage${rangeQuery()}`);
  state.usage = result.usage;
  state.aliases = result.api_aliases || {};
}

async function loadModels() {
  const payload = await api("/api/models").catch(() => ({ data: [] }));
  state.models = normaliseModels(payload);
}

async function loadUsers() {
  const payload = await api("/api/users");
  state.users = payload.users || [];
}

async function loadBackups() {
  const payload = await api("/api/backups");
  state.backups = payload.backups || [];
}

async function loadSnapshots() {
  const payload = await api("/api/snapshots");
  state.snapshots = payload.snapshots || [];
}

async function loadAlertsAndGroups() {
  const [alerts, groups] = await Promise.all([
    api("/api/alerts"),
    state.user.role === "admin" ? api("/api/groups") : Promise.resolve({ groups: [] }),
  ]);
  state.alerts = alerts.alerts || [];
  state.alertUsers = alerts.users || [];
  state.groups = groups.groups || [];
}

async function loadAudit() {
  const payload = await api("/api/audit?limit=300");
  state.audit = payload.events || [];
}

async function loadStatus() {
  state.status = await api("/api/system/status");
}

async function loadSettings() {
  const payload = await api("/api/settings");
  state.settings = payload.settings;
  applyAppearance();
}

async function loadInsights() {
  state.insights = await api(`/api/insights${rangeQuery()}`);
}

async function loadSessions() {
  const payload = await api("/api/sessions");
  state.sessions = payload.sessions || [];
}

async function loadDailyReport(notify) {
  state.report = await api(`/api/reports/daily${notify ? "?notify=1" : ""}`);
}

function render() {
  chartRegistry.length = 0;
  if (!state.token || !state.user) {
    renderLoginV2();
    return;
  }
  renderShellV2();
  requestAnimationFrame(drawCharts);
}

function renderLogin() {
  app.innerHTML = `
    <div class="login-shell">
      <section class="login-box">
        <div class="brand"><div class="mark">C</div><span>CPAMC Sidecar</span></div>
        <h1>API Key 登录</h1>
        <p class="muted">使用 CPAMC API Key 登录。管理员权限由本系统本地配置决定。</p>
        <form id="loginForm" class="form-grid">
          <label><span class="muted">CPAMC API Key</span><input name="apiKey" type="password" autocomplete="off" placeholder="sk-..." /></label>
          <button class="primary" type="submit">登录</button>
        </form>
        ${state.error ? `<div class="error">${escapeHTML(state.error)}</div>` : ""}
      </section>
    </div>
  `;
  document.querySelector("#loginForm").addEventListener("submit", onLogin);
}

function renderShell() {
  app.innerHTML = `
    <div class="layout">
      <aside class="sidebar">
        <div class="brand"><div class="mark">C</div><span>CPAMC Sidecar</span></div>
        <nav class="nav">
          ${navButton("dashboard", "仪表盘")}
          ${navButton("models", "可用模型")}
          ${state.user.role === "admin" ? navButton("users", "用户管理") : ""}
          ${state.user.role === "admin" ? navButton("alerts", "限额预警") : ""}
          ${state.user.role === "admin" ? navButton("backups", "备份恢复") : ""}
          ${state.user.role === "admin" ? navButton("snapshots", "使用快照") : ""}
          ${state.user.role === "admin" ? navButton("health", "系统健康") : ""}
          ${state.user.role === "admin" ? navButton("audit", "审计日志") : ""}
          ${navButton("profile", "个人资料")}
        </nav>
      </aside>
      <section class="main">
        <header class="topbar">
          <div class="page-title">
            <h1>${titleForView()}</h1>
            <p class="muted">${subtitleForView()}</p>
          </div>
          <div class="actions">
            <div class="user-chip"><span>${escapeHTML(state.user.displayName)}</span><span class="role">${state.user.role}</span><span>${escapeHTML(state.user.apiKeyPreview)}</span></div>
            <button id="refreshBtn">刷新</button>
            <button id="logoutBtn">退出</button>
          </div>
        </header>
        ${state.error ? `<div class="error">${escapeHTML(state.error)}</div>` : ""}
        ${state.loading ? `<div class="empty">正在加载数据...</div>` : renderView()}
      </section>
      ${state.drawer ? renderDrawer() : ""}
    </div>
  `;
  bindShellEvents();
}

function navButton(view, label) {
  return `<button data-view="${view}" class="${state.view === view ? "active" : ""}">${label}</button>`;
}

function renderLoginV2() {
  const appName = appearance().appName || "CPAMC Sidecar";
  const logoText = appearance().logoText || "C";
  app.innerHTML = `
    <div class="login-shell">
      <section class="login-box">
        <div class="brand"><div class="mark">${escapeHTML(logoText)}</div><span>${escapeHTML(appName)}</span></div>
        <h1>${t("loginTitle")}</h1>
        <p class="muted">${t("loginHint")}</p>
        <form id="loginForm" class="form-grid">
          <label><span class="muted">CPAMC API Key</span><input name="apiKey" type="password" autocomplete="off" placeholder="sk-..." /></label>
          <button class="primary" type="submit">${t("login")}</button>
        </form>
        ${state.error ? `<div class="error">${escapeHTML(state.error)}</div>` : ""}
      </section>
    </div>
  `;
  document.querySelector("#loginForm").addEventListener("submit", onLogin);
}

function renderShellV2() {
  const appName = appearance().appName || "CPAMC Sidecar";
  const logoText = appearance().logoText || "C";
  app.innerHTML = `
    <div class="layout ${state.fullscreen ? "fullscreen-mode" : ""}">
      <aside class="sidebar">
        <div class="brand"><div class="mark">${escapeHTML(logoText)}</div><span>${escapeHTML(appName)}</span></div>
        <nav class="nav">
          ${navButton("dashboard", t("dashboard"))}
          ${navButton("models", t("models"))}
          ${canAdminViewer() ? navButton("insights", t("insights")) : ""}
          ${state.user.role === "admin" ? navButton("users", t("users")) : ""}
          ${state.user.role === "admin" ? navButton("alerts", t("alerts")) : ""}
          ${state.user.role === "admin" ? navButton("backups", t("backups")) : ""}
          ${state.user.role === "admin" ? navButton("snapshots", t("snapshots")) : ""}
          ${canAdminViewer() ? navButton("sessions", t("sessions")) : ""}
          ${state.user.role === "admin" ? navButton("health", t("health")) : ""}
          ${state.user.role === "admin" ? navButton("audit", t("audit")) : ""}
          ${state.user.role === "admin" ? navButton("settings", t("settings")) : ""}
          ${navButton("profile", t("profile"))}
        </nav>
      </aside>
      <section class="main">
        <header class="topbar">
          <div class="page-title">
            <h1>${titleForViewV2()}</h1>
            <p class="muted">${subtitleForView()}</p>
          </div>
          <div class="actions">
            <div class="user-chip"><span>${escapeHTML(state.user.displayName)}</span><span class="role">${state.user.role}</span><span>${escapeHTML(state.user.apiKeyPreview)}</span></div>
            <select id="themeSelect" title="Theme">${themeOptions()}</select>
            <select id="languageSelect" title="Language">${languageOptions()}</select>
            <button id="fullscreenBtn">${state.fullscreen ? t("exitScreen") : t("bigScreen")}</button>
            <button id="refreshBtn">${t("refresh")}</button>
            <button id="logoutBtn">${t("logout")}</button>
          </div>
        </header>
        ${state.error ? `<div class="error">${escapeHTML(state.error)}</div>` : ""}
        ${state.loading ? `<div class="empty">${t("loading")}</div>` : renderView()}
      </section>
      ${state.drawer ? renderDrawer() : ""}
    </div>
  `;
  bindShellEvents();
}

function renderView() {
  if (state.view === "models") return renderModels();
  if (state.view === "insights") return renderInsights();
  if (state.view === "users") return renderUsers();
  if (state.view === "alerts") return renderAlerts();
  if (state.view === "backups") return renderBackups();
  if (state.view === "snapshots") return renderSnapshots();
  if (state.view === "health") return renderServerHealth();
  if (state.view === "audit") return renderAudit();
  if (state.view === "sessions") return renderSessions();
  if (state.view === "settings") return renderSettings();
  if (state.view === "profile") return renderProfile();
  return renderDashboard();
}

function renderRangeToolbar() {
  const presets = [
    ["1h", "1小时"],
    ["24h", "24小时"],
    ["7d", "7天"],
    ["30d", "30天"],
    ["custom", "自定义"],
  ];
  return `
    <section class="toolbar">
      <div class="segmented">
        ${presets.map(([value, label]) => `<button data-preset="${value}" class="${state.range.preset === value ? "active" : ""}">${label}</button>`).join("")}
      </div>
      <label><span>开始</span><input id="fromInput" type="datetime-local" value="${escapeHTML(state.range.from)}" ${state.range.preset !== "custom" ? "disabled" : ""} /></label>
      <label><span>结束</span><input id="toInput" type="datetime-local" value="${escapeHTML(state.range.to)}" ${state.range.preset !== "custom" ? "disabled" : ""} /></label>
      <button id="applyRangeBtn">应用</button>
      <button id="exportCsvBtn">导出 CSV</button>
      <button id="exportJsonBtn">导出 JSON</button>
    </section>
  `;
}

function renderDashboard() {
  const usage = state.usage || emptyUsage();
  const models = flattenModelRows(usage);
  const apis = flattenApiRows(usage);
  const breakdown = tokenBreakdown(usage);
  const successRate = usage.total_requests ? ((usage.success_count || 0) / usage.total_requests * 100).toFixed(1) : "0.0";
  const avgLatency = averageLatency(usage);
  const series = buildTimeSeries(usage);
  const topModels = models.slice(0, 8);

  chartRegistry.push({ id: "requestsChart", type: "line", data: series.map((item) => ({ label: item.label, value: item.requests })), color: "#20c788" });
  chartRegistry.push({ id: "tokensChart", type: "line", data: series.map((item) => ({ label: item.label, value: item.tokens })), color: "#8b5cf6" });
  chartRegistry.push({ id: "modelBarChart", type: "bar", data: topModels.map((item) => ({ label: item.model, value: item.tokens })), color: "#5fa8ff" });
  chartRegistry.push({ id: "tokenDonutChart", type: "donut", data: [
    { label: "输入", value: breakdown.input, color: "#9ca3af" },
    { label: "输出", value: breakdown.output, color: "#20c788" },
    { label: "缓存", value: breakdown.cached, color: "#f59e0b" },
    { label: "思考", value: breakdown.reasoning, color: "#8b5cf6" },
  ] });

  return `
    ${renderRangeToolbar()}
    ${state.alerts.length ? `<section class="alert-strip">${state.alerts.slice(0, 3).map((alert) => `<div class="alert ${alert.level}"><strong>${escapeHTML(alert.label)}</strong><span>${escapeHTML(alert.message)}</span></div>`).join("")}</section>` : ""}
    <div class="grid cards">
      ${metricCard("总请求数", formatNumber(usage.total_requests || 0), "请求成功率 " + successRate + "%")}
      ${metricCard("总 Token", compactNumber(usage.total_tokens || 0), "输入/输出/缓存/思考")}
      ${metricCard("平均延迟", avgLatency ? avgLatency.toFixed(2) + "s" : "--", "按请求明细估算")}
      ${metricCard("活跃模型", formatNumber(models.length), `${apis.length} 个 API Key`)}
    </div>
    <div class="grid chart-grid">
      ${chartPanel("请求趋势", "requestsChart")}
      ${chartPanel("Token 趋势", "tokensChart")}
      ${chartPanel("模型 Token 排行", "modelBarChart")}
      ${chartPanel("Token 类型分布", "tokenDonutChart")}
    </div>
    <section class="section">
      <div class="section-head">
        <h2>模型排行榜</h2>
        <div class="table-tools">
          <input id="searchInput" value="${escapeHTML(state.search)}" placeholder="搜索模型或 Key" />
          <select id="sortSelect">
            ${option("tokens", "按 Token")}
            ${option("requests", "按请求数")}
            ${option("latency", "按平均延迟")}
            ${option("failure", "按失败率")}
          </select>
        </div>
      </div>
      ${renderModelTable(models)}
    </section>
    ${state.user.role === "admin" ? `
      <section class="section">
        <div class="section-head"><h2>API Key 排行榜</h2><span class="muted">${apis.length} 个 Key</span></div>
        ${renderApiTable(apis)}
      </section>
      ${renderGroupSummary()}
    ` : ""}
  `;
}

function renderGroupSummary() {
  if (!state.groups.length) return "";
  return `
    <section class="section">
      <div class="section-head"><h2>分组统计</h2><span class="muted">${state.groups.length} 个分组</span></div>
      ${table(["分组", "用户", "Key", "请求", "Token", "模型"], state.groups.map((group) => [
        escapeHTML(group.name),
        formatNumber(group.users),
        formatNumber(group.apiKeys),
        formatNumber(group.requests),
        formatNumber(group.tokens),
        formatNumber(group.models),
      ]))}
    </section>
  `;
}

function renderModelTable(rows) {
  const filtered = filterRows(rows, (row) => row.model);
  const sorted = sortModelRows(filtered);
  const page = paginate(sorted, state.page, 12);
  if (!page.rows.length) return `<div class="empty">当前时间范围没有匹配的模型记录</div>`;
  return `
    ${table(["模型", "请求", "Token", "平均延迟", "失败率", "输入", "输出", "缓存", "思考"], page.rows.map((row) => [
      `<button class="linkish" data-model-detail="${escapeHTML(row.model)}">${escapeHTML(row.model)}</button>`,
      formatNumber(row.requests),
      formatNumber(row.tokens),
      row.avgLatency ? row.avgLatency.toFixed(2) + "s" : "--",
      row.failureRate.toFixed(1) + "%",
      formatNumber(row.input),
      formatNumber(row.output),
      formatNumber(row.cached),
      formatNumber(row.reasoning),
    ]))}
    ${pagination(page)}
  `;
}

function renderApiTable(rows) {
  const filtered = filterRows(rows, (row) => `${row.api} ${row.alias || ""}`);
  const sorted = filtered.sort((a, b) => b.tokens - a.tokens);
  if (!sorted.length) return `<div class="empty">暂无 API Key 统计</div>`;
  return table(["别名", "API Key", "请求", "Token", "模型数", "失败率"], sorted.map((row) => [
    escapeHTML(row.alias || "--"),
    `<button class="linkish" data-api-detail="${escapeHTML(row.api)}">${escapeHTML(maskMaybe(row.api))}</button>`,
    formatNumber(row.requests),
    formatNumber(row.tokens),
    formatNumber(row.modelCount),
    row.failureRate.toFixed(1) + "%",
  ]));
}

function renderModels() {
  const models = state.models || [];
  return `
    <section class="section">
      <div class="section-head">
        <h2>当前 API Key 可用模型</h2>
        <button id="loadModelsBtn">重新读取</button>
      </div>
      ${models.length ? table(["模型 ID", "类型"], models.map((model) => [
        escapeHTML(model.id || model.name || "-"),
        escapeHTML(model.object || model.type || "-"),
      ])) : `<div class="empty">点击“重新读取”获取模型列表</div>`}
    </section>
  `;
}

function renderUsers() {
  return `
    <div class="grid two">
      <section class="section">
        <div class="section-head"><h2>用户列表</h2><span class="muted">${state.users.length} 人</span></div>
        ${state.users.length ? table(["名称", "分组", "备注", "角色", "Key", "限额", "状态", "操作"], state.users.map((user) => [
          `<input data-user-name="${user.id}" value="${escapeHTML(user.displayName)}" />`,
          `<input data-user-group="${user.id}" value="${escapeHTML(user.group || "")}" placeholder="例如 测试组" />`,
          `<input data-user-note="${user.id}" value="${escapeHTML(user.note || "")}" placeholder="负责人/用途" />`,
          `<select data-user-role="${user.id}"><option value="user" ${user.role === "user" ? "selected" : ""}>user</option><option value="admin" ${user.role === "admin" ? "selected" : ""}>admin</option></select>`,
          renderUserKeys(user),
          renderLimitInputs(user),
          user.disabled ? `<span class="warn">禁用</span>` : `<span class="ok">启用</span>`,
          `<div class="actions"><button data-save-user="${user.id}">保存</button><button data-toggle-user="${user.id}">${user.disabled ? "启用" : "禁用"}</button><button class="danger" data-delete-user="${user.id}">删除</button></div>`,
        ])) : `<div class="empty">暂无用户</div>`}
      </section>
      <section class="section">
        <div class="section-head"><h2>添加或更新用户</h2></div>
        <form class="form-grid" id="addUserForm">
          <label><span class="muted">显示名称</span><input name="displayName" placeholder="例如 张三" /></label>
          <label><span class="muted">分组</span><input name="group" placeholder="例如 正式组 / 客户 A" /></label>
          <label><span class="muted">备注</span><input name="note" placeholder="例如 测试组 / 客户 A" /></label>
          <label><span class="muted">API Key</span><input name="apiKey" type="password" placeholder="sk-..." /></label>
          <label><span class="muted">角色</span><select name="role"><option value="user">普通用户</option><option value="admin">管理员</option></select></label>
          <button class="primary" type="submit">保存用户</button>
        </form>
        <div class="divider"></div>
        <div class="section-head"><h2>绑定附加 Key</h2></div>
        <form class="form-grid" id="addUserKeyForm">
          <label><span class="muted">选择用户</span><select name="userId">${state.users.map((user) => `<option value="${user.id}">${escapeHTML(user.displayName)}</option>`).join("")}</select></label>
          <label><span class="muted">Key 标签</span><input name="label" placeholder="例如 Codex 备用" /></label>
          <label><span class="muted">API Key</span><input name="apiKey" type="password" placeholder="sk-..." /></label>
          <button class="primary" type="submit">绑定 Key</button>
        </form>
      </section>
    </div>
  `;
}

function renderUserKeys(user) {
  const keys = user.apiKeys || [];
  if (!keys.length) return escapeHTML(user.apiKeyPreview || "--");
  return `<div class="key-list">${keys.map((key) => `<span class="key-pill"><b>${escapeHTML(key.preview)}</b>${key.label ? `<small>${escapeHTML(key.label)}</small>` : ""}<button data-delete-user-key="${user.id}:${key.id}">×</button></span>`).join("")}</div>`;
}

function renderLimitInputs(user) {
  const limits = user.limits || {};
  return `
    <div class="limit-grid">
      <input data-limit="${user.id}:dailyTokens" value="${limits.dailyTokens || ""}" placeholder="日Token" />
      <input data-limit="${user.id}:monthlyTokens" value="${limits.monthlyTokens || ""}" placeholder="30天Token" />
      <input data-limit="${user.id}:dailyRequests" value="${limits.dailyRequests || ""}" placeholder="日请求" />
      <input data-limit="${user.id}:monthlyRequests" value="${limits.monthlyRequests || ""}" placeholder="30天请求" />
    </div>
  `;
}

function renderAlerts() {
  return `
    <div class="grid two">
      <section class="section">
        <div class="section-head"><h2>预警事件</h2><button id="loadAlertsBtn">刷新</button></div>
        ${state.alerts.length ? table(["等级", "用户", "项目", "已用", "限额", "进度"], state.alerts.map((alert) => [
          alert.level === "danger" ? `<span class="warn">超限</span>` : `<span class="ok">接近</span>`,
          escapeHTML(alert.user.displayName),
          escapeHTML(alert.label),
          formatNumber(alert.used),
          formatNumber(alert.limit),
          Math.round(alert.ratio * 100) + "%",
        ])) : `<div class="empty">暂无预警。给用户设置限额后，这里会显示达到 80% 或超限的项目。</div>`}
      </section>
      <section class="section">
        <div class="section-head"><h2>用户用量进度</h2></div>
        ${state.alertUsers.length ? table(["用户", "今日请求", "今日Token", "30天请求", "30天Token"], state.alertUsers.map((row) => [
          escapeHTML(row.user.displayName),
          formatNumber(row.today.requests),
          formatNumber(row.today.tokens),
          formatNumber(row.month.requests),
          formatNumber(row.month.tokens),
        ])) : `<div class="empty">暂无用户用量</div>`}
      </section>
    </div>
    ${renderGroupSummary()}
  `;
}

function renderBackups() {
  return `
    <div class="grid two">
      <section class="section">
        <div class="section-head"><h2>备份文件</h2><div class="actions"><button id="createBackupBtn">立即备份</button><button id="exportBackupBtn">导出备份</button></div></div>
        ${state.backups.length ? table(["文件", "大小", "时间", "操作"], state.backups.map((backup) => [
          escapeHTML(backup.fileName),
          bytes(backup.size),
          formatDate(backup.updatedAt),
          `<div class="actions"><button data-download-backup="${backup.fileName}">下载</button><button class="danger" data-delete-backup="${backup.fileName}">删除</button></div>`,
        ])) : `<div class="empty">暂无备份文件</div>`}
      </section>
      <section class="section">
        <div class="section-head"><h2>导入备份</h2></div>
        <form class="form-grid" id="importBackupForm">
          <input name="file" type="file" accept="application/json,.json" />
          <label><span class="muted">导入模式</span><select name="mode"><option value="merge">合并</option><option value="replace">覆盖</option></select></label>
          <button class="primary" type="submit">导入</button>
          <p class="muted">备份只包含本系统用户、角色、别名和备注，不包含 CPAMC 管理密码。</p>
        </form>
      </section>
    </div>
  `;
}

function renderSnapshots() {
  return `
    <section class="section">
      <div class="section-head"><h2>CPAMC Usage 快照</h2><div class="actions"><button id="createSnapshotBtn">立即创建快照</button></div></div>
      <p class="muted">快照会保存 CPAMC 当前 usage 聚合数据，用于重启或迁移后做历史留存。只有管理员可下载。</p>
      ${state.snapshots.length ? table(["文件", "原因", "Key", "请求", "Token", "大小", "时间", "操作"], state.snapshots.map((snapshot) => [
        escapeHTML(snapshot.fileName),
        escapeHTML(snapshot.reason || ""),
        formatNumber(snapshot.apiKeyCount || 0),
        formatNumber(snapshot.totalRequests || 0),
        formatNumber(snapshot.totalTokens || 0),
        bytes(snapshot.size),
        formatDate(snapshot.updatedAt),
        `<div class="actions"><button data-download-snapshot="${snapshot.fileName}">下载</button><button class="danger" data-delete-snapshot="${snapshot.fileName}">删除</button></div>`,
      ])) : `<div class="empty">暂无快照文件</div>`}
    </section>
  `;
}

function renderHealth() {
  const status = state.status;
  if (!status) return `<section class="section"><button id="loadStatusBtn">检查系统状态</button></section>`;
  return `
    <div class="grid cards">
      ${metricCard("系统状态", status.ok ? "正常" : "异常", `Node ${status.app.node}`)}
      ${metricCard("CPAMC 健康", status.cpamc.health, status.cpamc.base_url)}
      ${metricCard("管理接口", status.cpamc.management, `${formatNumber(status.cpamc.api_key_count)} 个 Key`)}
      ${metricCard("运行时间", duration(status.app.uptime_seconds), "自动备份 " + (status.auto_backup.enabled ? "开启" : "关闭"))}
    </div>
    <section class="section">
      <div class="section-head"><h2>存储</h2><button id="loadStatusBtn">重新检查</button></div>
      ${table(["项目", "值"], [
        ["用户数", formatNumber(status.storage.user_count)],
        ["备份数", formatNumber(status.storage.backup_count)],
        ["近期审计事件", formatNumber(status.storage.audit_events_recent)],
        ["CPAMC 总请求", formatNumber(status.cpamc.total_requests)],
        ["CPAMC 总 Token", formatNumber(status.cpamc.total_tokens)],
      ])}
    </section>
  `;
}

function renderServerHealth() {
  const status = state.status;
  if (!status) return `<section class="section"><button id="loadStatusBtn">检查系统状态</button></section>`;
  const server = status.server || {};
  const cpu = server.cpu || {};
  const memory = server.memory || {};
  const processInfo = server.process || {};
  const processMemory = processInfo.memory || {};
  const disks = server.disks || [];
  return `
    <div class="grid cards">
      ${metricCard("系统状态", status.ok ? "正常" : "异常", `Node ${status.app.node}`)}
      ${metricCard("CPU 占用", percent(cpu.usage_percent), `${cpu.cores || 0} 核`)}
      ${metricCard("内存占用", percent(memory.used_percent), `${bytes(memory.used || 0)} / ${bytes(memory.total || 0)}`)}
      ${metricCard("运行时间", duration(status.app.uptime_seconds), "应用进程")}
    </div>
    <div class="grid cards">
      ${metricCard("CPAMC 健康", status.cpamc.health, status.cpamc.base_url)}
      ${metricCard("管理接口", status.cpamc.management, `${formatNumber(status.cpamc.api_key_count)} 个 Key`)}
      ${metricCard("服务器运行", duration(server.uptime_seconds || 0), `${server.platform || ""} ${server.release || ""}`)}
      ${metricCard("进程内存", bytes(processMemory.rss || 0), `Heap ${bytes(processMemory.heap_used || 0)}`)}
    </div>
    <section class="section">
      <div class="section-head"><h2>服务器参数</h2><button id="loadStatusBtn">重新检查</button></div>
      ${table(["项目", "值"], [
        ["主机名", escapeHTML(server.hostname || "--")],
        ["系统", escapeHTML(`${server.type || ""} ${server.release || ""} ${server.arch || ""}`.trim())],
        ["CPU", escapeHTML(cpu.model || "--")],
        ["时区", escapeHTML(server.timezone || "--")],
        ["当前时间", formatDate(server.current_time)],
        ["进程 PID", formatNumber(processInfo.pid || 0)],
        ["工作目录", `<code>${escapeHTML(processInfo.cwd || "")}</code>`],
      ])}
    </section>
    <section class="section">
      <div class="section-head"><h2>磁盘状态</h2><span class="muted">${disks.length} 个卷</span></div>
      ${disks.length ? table(["磁盘", "文件系统", "已用", "可用", "总容量", "占用"], disks.map((disk) => [
        escapeHTML([disk.name || disk.mount || "--", disk.label ? `(${disk.label})` : ""].join(" ")),
        escapeHTML(disk.filesystem || "--"),
        bytes(disk.used || 0),
        bytes(disk.free || 0),
        bytes(disk.total || 0),
        percent(disk.used_percent || 0),
      ])) : `<div class="empty">未读取到磁盘数据</div>`}
    </section>
    <section class="section">
      <div class="section-head"><h2>应用存储</h2></div>
      ${table(["项目", "值"], [
        ["用户数", formatNumber(status.storage.user_count)],
        ["备份数", formatNumber(status.storage.backup_count)],
        ["Usage 快照数", formatNumber(status.storage.usage_snapshot_count || 0)],
        ["近期审计事件", formatNumber(status.storage.audit_events_recent)],
        ["CPAMC 总请求", formatNumber(status.cpamc.total_requests)],
        ["CPAMC 总 Token", formatNumber(status.cpamc.total_tokens)],
      ])}
    </section>
  `;
}

function renderAudit() {
  return `
    <section class="section">
      <div class="section-head"><h2>审计日志</h2><button id="loadAuditBtn">刷新</button></div>
      ${state.audit.length ? table(["时间", "动作", "操作者", "详情"], state.audit.map((event) => [
        formatDate(event.timestamp),
        escapeHTML(event.action),
        escapeHTML(event.actor ? `${event.actor.displayName} (${event.actor.role})` : "system"),
        `<code>${escapeHTML(JSON.stringify(event.details || {}))}</code>`,
      ])) : `<div class="empty">暂无审计事件</div>`}
    </section>
  `;
}

function renderProfile() {
  return `
    <section class="section profile-panel">
      <div class="section-head"><h2>个人资料</h2></div>
      <form class="form-grid" id="profileForm">
        <label><span class="muted">显示名称</span><input name="displayName" value="${escapeHTML(state.user.displayName)}" /></label>
        <label><span class="muted">备注</span><input name="note" value="${escapeHTML(state.user.note || "")}" placeholder="用途或负责人" /></label>
        <label><span class="muted">API Key</span><input value="${escapeHTML(state.user.apiKeyPreview)}" disabled /></label>
        <label><span class="muted">角色</span><input value="${escapeHTML(state.user.role)}" disabled /></label>
        <button class="primary" type="submit">保存资料</button>
      </form>
    </section>
  `;
}

function renderDrawer() {
  const usage = state.usage || emptyUsage();
  const title = state.drawer.type === "model" ? state.drawer.value : (state.aliases[state.drawer.value] || maskMaybe(state.drawer.value));
  const details = state.drawer.type === "model"
    ? detailsForModel(usage, state.drawer.value)
    : detailsForApi(usage, state.drawer.value);
  const breakdown = details.reduce((acc, item) => {
    const t = item.tokens || {};
    acc.input += Number(t.input_tokens || 0);
    acc.output += Number(t.output_tokens || 0);
    acc.cached += Number(t.cached_tokens || 0);
    acc.reasoning += Number(t.reasoning_tokens || 0);
    acc.total += Number(t.total_tokens || 0);
    return acc;
  }, { input: 0, output: 0, cached: 0, reasoning: 0, total: 0 });
  return `
    <aside class="drawer">
      <div class="drawer-head">
        <div><h2>${escapeHTML(title)}</h2><p class="muted">${details.length} 条请求明细</p></div>
        <button id="closeDrawerBtn">关闭</button>
      </div>
      <div class="mini-grid">
        ${metricCard("请求", formatNumber(details.length), "")}
        ${metricCard("Token", formatNumber(breakdown.total), "")}
      </div>
      ${table(["时间", "模型", "API Key", "Token", "延迟", "状态"], details.slice(0, 80).map((item) => [
        formatDate(item.timestamp),
        escapeHTML(item.model),
        escapeHTML(maskMaybe(item.api)),
        formatNumber((item.tokens || {}).total_tokens || 0),
        item.latency_ms ? (item.latency_ms / 1000).toFixed(2) + "s" : "--",
        item.failed ? `<span class="warn">失败</span>` : `<span class="ok">成功</span>`,
      ]))}
    </aside>
  `;
}

function bindShellEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.view = button.dataset.view;
      state.page = 1;
      state.error = "";
      if (state.view === "models") await loadModels();
      if (state.view === "users") await loadUsers();
      if (state.view === "backups") await loadBackups();
      if (state.view === "snapshots") await loadSnapshots();
      if (state.view === "alerts") await loadAlertsAndGroups();
      if (state.view === "audit") await loadAudit();
      if (state.view === "health") await loadStatus();
      if (state.view === "insights") await loadInsights();
      if (state.view === "sessions") await loadSessions();
      if (state.view === "settings") await loadSettings();
      render();
    });
  });
  on("#refreshBtn", "click", refreshAll);
  on("#logoutBtn", "click", () => logout(true));
  on("#applyRangeBtn", "click", applyRange);
  on("#exportCsvBtn", "click", () => downloadFile(`/api/usage/export${rangeQuery("&")}format=csv`, "usage.csv"));
  on("#exportJsonBtn", "click", () => downloadFile(`/api/usage/export${rangeQuery("&")}format=json`, "usage.json"));
  document.querySelectorAll("[data-preset]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.range.preset = button.dataset.preset;
      state.page = 1;
      if (state.range.preset !== "custom") await refreshAll();
      else render();
    });
  });
  on("#searchInput", "input", (event) => {
    state.search = event.target.value;
    state.page = 1;
    render();
  });
  on("#sortSelect", "change", (event) => {
    state.sort = event.target.value;
    render();
  });
  document.querySelectorAll("[data-page]").forEach((button) => {
    button.addEventListener("click", () => {
      state.page = Number(button.dataset.page);
      render();
    });
  });
  document.querySelectorAll("[data-model-detail]").forEach((button) => {
    button.addEventListener("click", () => {
      state.drawer = { type: "model", value: button.dataset.modelDetail };
      render();
    });
  });
  document.querySelectorAll("[data-api-detail]").forEach((button) => {
    button.addEventListener("click", () => {
      state.drawer = { type: "api", value: button.dataset.apiDetail };
      render();
    });
  });
  on("#closeDrawerBtn", "click", () => {
    state.drawer = null;
    render();
  });
  on("#loadModelsBtn", "click", async () => {
    await loadModels();
    render();
  });
  on("#addUserForm", "submit", onAddUser);
  on("#addUserKeyForm", "submit", onAddUserKey);
  on("#profileForm", "submit", onProfileSave);
  document.querySelectorAll("[data-save-user]").forEach((button) => button.addEventListener("click", () => saveUser(button.dataset.saveUser)));
  document.querySelectorAll("[data-toggle-user]").forEach((button) => button.addEventListener("click", () => toggleUser(button.dataset.toggleUser)));
  document.querySelectorAll("[data-delete-user]").forEach((button) => button.addEventListener("click", () => deleteUser(button.dataset.deleteUser)));
  document.querySelectorAll("[data-delete-user-key]").forEach((button) => button.addEventListener("click", () => {
    const [userId, keyId] = button.dataset.deleteUserKey.split(":");
    deleteUserKey(userId, keyId);
  }));
  on("#createBackupBtn", "click", async () => {
    await api("/api/backups", { method: "POST" });
    await loadBackups();
    render();
  });
  on("#exportBackupBtn", "click", () => downloadFile("/api/backups/export", "backup.json"));
  document.querySelectorAll("[data-download-backup]").forEach((button) => button.addEventListener("click", () => downloadFile(`/api/backups/${encodeURIComponent(button.dataset.downloadBackup)}`, button.dataset.downloadBackup)));
  document.querySelectorAll("[data-delete-backup]").forEach((button) => button.addEventListener("click", () => deleteBackup(button.dataset.deleteBackup)));
  on("#importBackupForm", "submit", onImportBackup);
  on("#createSnapshotBtn", "click", async () => {
    await api("/api/snapshots", { method: "POST" });
    await loadSnapshots();
    render();
  });
  document.querySelectorAll("[data-download-snapshot]").forEach((button) => button.addEventListener("click", () => downloadFile(`/api/snapshots/${encodeURIComponent(button.dataset.downloadSnapshot)}`, button.dataset.downloadSnapshot)));
  document.querySelectorAll("[data-delete-snapshot]").forEach((button) => button.addEventListener("click", () => deleteSnapshot(button.dataset.deleteSnapshot)));
  on("#loadStatusBtn", "click", async () => {
    await loadStatus();
    render();
  });
  on("#loadAlertsBtn", "click", async () => {
    await loadAlertsAndGroups();
    render();
  });
  on("#loadAuditBtn", "click", async () => {
    await loadAudit();
    render();
  });
  bindEnhancedEvents();
}

function on(selector, event, handler) {
  const el = document.querySelector(selector);
  if (el) el.addEventListener(event, handler);
}

async function onLogin(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  state.error = "";
  try {
    const result = await api("/api/login", {
      method: "POST",
      body: { apiKey: form.get("apiKey") },
      auth: false,
    });
    state.token = result.token;
    state.user = result.user;
    localStorage.setItem("cpamc_sidecar_token", state.token);
    await refreshAll();
  } catch (err) {
    state.error = err.message;
    render();
  }
}

async function onAddUser(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  await api("/api/users", {
    method: "POST",
    body: {
      displayName: form.get("displayName"),
      group: form.get("group"),
      note: form.get("note"),
      apiKey: form.get("apiKey"),
      role: form.get("role"),
    },
  });
  event.currentTarget.reset();
  await loadUsers();
  render();
}

async function saveUser(id) {
  await api(`/api/users/${id}`, {
    method: "PATCH",
    body: {
      displayName: valueOf(`[data-user-name="${id}"]`),
      group: valueOf(`[data-user-group="${id}"]`),
      note: valueOf(`[data-user-note="${id}"]`),
      role: valueOf(`[data-user-role="${id}"]`),
      limits: limitsForUser(id),
    },
  });
  await loadUsers();
  render();
}

async function onAddUserKey(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const userId = form.get("userId");
  await api(`/api/users/${userId}/api-keys`, {
    method: "POST",
    body: {
      label: form.get("label"),
      apiKey: form.get("apiKey"),
    },
  });
  event.currentTarget.reset();
  await loadUsers();
  render();
}

async function deleteUserKey(userId, keyId) {
  if (!confirm("确认解绑这个 API Key？")) return;
  await api(`/api/users/${userId}/api-keys/${keyId}`, { method: "DELETE" });
  await loadUsers();
  render();
}

function limitsForUser(id) {
  const out = {};
  document.querySelectorAll(`[data-limit^="${id}:"]`).forEach((input) => {
    const key = input.dataset.limit.split(":")[1];
    out[key] = Number(input.value || 0);
  });
  return out;
}

async function toggleUser(id) {
  const user = state.users.find((item) => item.id === id);
  await api(`/api/users/${id}`, { method: "PATCH", body: { disabled: !user.disabled } });
  await loadUsers();
  render();
}

async function deleteUser(id) {
  if (!confirm("确认删除这个本地用户配置？")) return;
  await api(`/api/users/${id}`, { method: "DELETE" });
  await loadUsers();
  render();
}

async function deleteBackup(fileName) {
  if (!confirm("确认删除这个备份？")) return;
  await api(`/api/backups/${encodeURIComponent(fileName)}`, { method: "DELETE" });
  await loadBackups();
  render();
}

async function deleteSnapshot(fileName) {
  if (!confirm("确认删除这个 usage 快照？")) return;
  await api(`/api/snapshots/${encodeURIComponent(fileName)}`, { method: "DELETE" });
  await loadSnapshots();
  render();
}

async function onImportBackup(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const file = form.get("file");
  if (!file || !file.size) return;
  const text = await file.text();
  const backup = JSON.parse(text);
  const mode = form.get("mode");
  if (mode === "replace" && !confirm("覆盖会替换当前用户配置，确认继续？")) return;
  await api("/api/backups/import", { method: "POST", body: { mode, backup } });
  await Promise.all([loadUsers().catch(() => {}), loadBackups()]);
  render();
}

async function onProfileSave(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const result = await api("/api/me", {
    method: "PATCH",
    body: {
      displayName: form.get("displayName"),
      note: form.get("note"),
    },
  });
  state.user = result.user;
  render();
}

async function applyRange() {
  state.range.from = valueOf("#fromInput");
  state.range.to = valueOf("#toInput");
  state.range.preset = "custom";
  state.page = 1;
  await refreshAll();
}

function valueOf(selector) {
  const el = document.querySelector(selector);
  return el ? el.value : "";
}

function logout(callServer) {
  if (callServer && state.token) api("/api/logout", { method: "POST" }).catch(() => {});
  state.token = "";
  state.user = null;
  state.usage = null;
  localStorage.removeItem("cpamc_sidecar_token");
  render();
}

async function api(url, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (options.auth !== false && state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || `请求失败：${response.status}`);
  return data;
}

async function downloadFile(url, fallbackName) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${state.token}` } });
  if (!response.ok) throw new Error("下载失败");
  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition") || "";
  const match = disposition.match(/filename="([^"]+)"/);
  const name = match ? match[1] : fallbackName;
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.click();
  URL.revokeObjectURL(href);
}

function rangeQuery(joiner) {
  const prefix = joiner ? "?" : "?";
  const params = new URLSearchParams();
  if (state.range.preset && state.range.preset !== "custom") params.set("preset", state.range.preset);
  if (state.range.preset === "custom") {
    if (state.range.from) params.set("from", new Date(state.range.from).toISOString());
    if (state.range.to) params.set("to", new Date(state.range.to).toISOString());
  }
  const query = params.toString();
  if (!joiner) return query ? `${prefix}${query}` : "";
  return query ? `?${query}${joiner}` : "?";
}

function emptyUsage() {
  return { total_requests: 0, success_count: 0, failure_count: 0, total_tokens: 0, apis: {} };
}

function flattenModelRows(usage) {
  const rows = new Map();
  for (const [api, apiStats] of Object.entries(usage.apis || {})) {
    for (const [model, modelStats] of Object.entries(apiStats.models || {})) {
      const row = rows.get(model) || { model, requests: 0, tokens: 0, input: 0, output: 0, cached: 0, reasoning: 0, failed: 0, latencySum: 0, latencyCount: 0, details: [] };
      row.requests += Number(modelStats.total_requests || 0);
      row.tokens += Number(modelStats.total_tokens || 0);
      for (const detail of modelStats.details || []) {
        const t = detail.tokens || {};
        row.input += Number(t.input_tokens || 0);
        row.output += Number(t.output_tokens || 0);
        row.cached += Number(t.cached_tokens || 0);
        row.reasoning += Number(t.reasoning_tokens || 0);
        if (detail.failed) row.failed += 1;
        if (detail.latency_ms) {
          row.latencySum += Number(detail.latency_ms);
          row.latencyCount += 1;
        }
        row.details.push({ ...detail, api, model });
      }
      row.avgLatency = row.latencyCount ? row.latencySum / row.latencyCount / 1000 : 0;
      row.failureRate = row.requests ? row.failed / row.requests * 100 : 0;
      rows.set(model, row);
    }
  }
  return [...rows.values()];
}

function flattenApiRows(usage) {
  return Object.entries(usage.apis || {}).map(([api, apiStats]) => {
    let failed = 0;
    let total = 0;
    for (const modelStats of Object.values(apiStats.models || {})) {
      for (const detail of modelStats.details || []) {
        total += 1;
        if (detail.failed) failed += 1;
      }
    }
    return {
      api,
      alias: state.aliases[api] || "",
      requests: Number(apiStats.total_requests || 0),
      tokens: Number(apiStats.total_tokens || 0),
      modelCount: Object.keys(apiStats.models || {}).length,
      failureRate: total ? failed / total * 100 : 0,
    };
  });
}

function filterRows(rows, textFn) {
  const q = state.search.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) => textFn(row).toLowerCase().includes(q));
}

function sortModelRows(rows) {
  return [...rows].sort((a, b) => {
    if (state.sort === "requests") return b.requests - a.requests;
    if (state.sort === "latency") return b.avgLatency - a.avgLatency;
    if (state.sort === "failure") return b.failureRate - a.failureRate;
    return b.tokens - a.tokens;
  });
}

function tokenBreakdown(usage) {
  return flattenModelRows(usage).reduce((acc, row) => {
    acc.input += row.input;
    acc.output += row.output;
    acc.cached += row.cached;
    acc.reasoning += row.reasoning;
    return acc;
  }, { input: 0, output: 0, cached: 0, reasoning: 0 });
}

function averageLatency(usage) {
  let total = 0;
  let count = 0;
  for (const row of flattenModelRows(usage)) {
    total += row.latencySum;
    count += row.latencyCount;
  }
  return count ? total / count / 1000 : 0;
}

function buildTimeSeries(usage) {
  const points = new Map();
  for (const row of flattenModelRows(usage)) {
    for (const detail of row.details) {
      const date = new Date(detail.timestamp);
      if (Number.isNaN(date.getTime())) continue;
      const key = bucketKey(date);
      const point = points.get(key) || { label: key, requests: 0, tokens: 0 };
      point.requests += 1;
      point.tokens += Number((detail.tokens || {}).total_tokens || 0);
      points.set(key, point);
    }
  }
  return [...points.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function bucketKey(date) {
  if (state.range.preset === "1h") return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (state.range.preset === "24h") return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:00`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function detailsForModel(usage, model) {
  return flattenModelRows(usage).find((row) => row.model === model)?.details || [];
}

function detailsForApi(usage, api) {
  const out = [];
  const apiStats = (usage.apis || {})[api];
  for (const [model, modelStats] of Object.entries((apiStats && apiStats.models) || {})) {
    for (const detail of modelStats.details || []) out.push({ ...detail, api, model });
  }
  return out.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

function normaliseModels(payload) {
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.models)) return payload.models;
  return [];
}

function drawCharts() {
  for (const chart of chartRegistry) {
    const canvas = document.getElementById(chart.id);
    if (!canvas) continue;
    const rect = canvas.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, rect.width * scale);
    canvas.height = Math.max(1, rect.height * scale);
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    if (chart.type === "line") drawLineChart(ctx, rect, chart);
    if (chart.type === "bar") drawBarChart(ctx, rect, chart);
    if (chart.type === "donut") drawDonutChart(ctx, rect, chart);
  }
}

function drawLineChart(ctx, rect, chart) {
  const data = chart.data || [];
  drawChartFrame(ctx, rect);
  if (!data.length) return drawNoData(ctx, rect);
  const max = Math.max(...data.map((p) => p.value), 1);
  const padX = 34;
  const padY = 22;
  ctx.strokeStyle = chart.color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  data.forEach((p, index) => {
    const x = padX + (rect.width - padX - 10) * (data.length === 1 ? 1 : index / (data.length - 1));
    const y = rect.height - padY - (rect.height - padY * 2) * (p.value / max);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = chart.color;
  data.forEach((p, index) => {
    const x = padX + (rect.width - padX - 10) * (data.length === 1 ? 1 : index / (data.length - 1));
    const y = rect.height - padY - (rect.height - padY * 2) * (p.value / max);
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawBarChart(ctx, rect, chart) {
  const data = chart.data || [];
  drawChartFrame(ctx, rect);
  if (!data.length) return drawNoData(ctx, rect);
  const max = Math.max(...data.map((p) => p.value), 1);
  const barH = Math.max(8, (rect.height - 36) / data.length - 7);
  data.forEach((p, index) => {
    const y = 20 + index * (barH + 7);
    const w = (rect.width - 120) * (p.value / max);
    ctx.fillStyle = "rgba(95, 168, 255, 0.2)";
    ctx.fillRect(100, y, rect.width - 118, barH);
    ctx.fillStyle = chart.color;
    ctx.fillRect(100, y, Math.max(2, w), barH);
    ctx.fillStyle = "#d9d3ca";
    ctx.font = "11px Segoe UI";
    ctx.fillText(String(p.label).slice(0, 14), 10, y + barH - 1);
  });
}

function drawDonutChart(ctx, rect, chart) {
  const data = (chart.data || []).filter((p) => p.value > 0);
  if (!data.length) return drawNoData(ctx, rect);
  const total = data.reduce((sum, p) => sum + p.value, 0);
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  const radius = Math.min(rect.width, rect.height) / 2 - 16;
  let start = -Math.PI / 2;
  data.forEach((p) => {
    const angle = (p.value / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.strokeStyle = p.color;
    ctx.lineWidth = 18;
    ctx.arc(cx, cy, radius, start, start + angle);
    ctx.stroke();
    start += angle;
  });
  ctx.fillStyle = "#f4f0e8";
  ctx.font = "700 18px Segoe UI";
  ctx.textAlign = "center";
  ctx.fillText(compactNumber(total), cx, cy + 6);
  ctx.textAlign = "left";
}

function drawChartFrame(ctx, rect) {
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.strokeStyle = "rgba(255,255,255,.08)";
  ctx.lineWidth = 1;
  for (let i = 1; i <= 3; i++) {
    const y = (rect.height / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(rect.width, y);
    ctx.stroke();
  }
}

function drawNoData(ctx, rect) {
  ctx.fillStyle = "#b8afa2";
  ctx.font = "13px Segoe UI";
  ctx.textAlign = "center";
  ctx.fillText("暂无数据", rect.width / 2, rect.height / 2);
  ctx.textAlign = "left";
}

function chartPanel(title, id) {
  return `<section class="section chart-panel"><div class="section-head"><h2>${title}</h2></div><canvas id="${id}"></canvas></section>`;
}

function metricCard(label, value, hint) {
  return `<article class="card"><span>${label}</span><strong>${value}</strong><small>${escapeHTML(hint || "")}</small></article>`;
}

function table(headers, rows) {
  return `
    <div class="table-wrap">
      <table>
        <thead><tr>${headers.map((h) => `<th>${escapeHTML(h)}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody>
      </table>
    </div>
  `;
}

function paginate(rows, page, size) {
  const totalPages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(Math.max(1, page), totalPages);
  return { rows: rows.slice((current - 1) * size, current * size), page: current, totalPages, total: rows.length };
}

function pagination(page) {
  if (page.totalPages <= 1) return "";
  return `<div class="pagination"><span>${page.page}/${page.totalPages} · ${page.total} 条</span><button data-page="${page.page - 1}" ${page.page <= 1 ? "disabled" : ""}>上一页</button><button data-page="${page.page + 1}" ${page.page >= page.totalPages ? "disabled" : ""}>下一页</button></div>`;
}

function option(value, label) {
  return `<option value="${value}" ${state.sort === value ? "selected" : ""}>${label}</option>`;
}

function titleForView() {
  return {
    dashboard: "使用仪表盘",
    models: "可用模型",
    users: "用户管理",
    alerts: "限额预警",
    backups: "备份恢复",
    snapshots: "使用快照",
    health: "系统健康",
    audit: "审计日志",
    profile: "个人资料",
  }[state.view] || "使用仪表盘";
}

function subtitleForView() {
  if (state.view === "dashboard") return state.user.role === "admin" ? "全局 API Key、模型、Token 和延迟趋势。" : "当前 API Key 的模型和 Token 用量。";
  if (state.view === "alerts") return "按用户限额监控接近 80% 和超限的使用风险。";
  if (state.view === "backups") return "导出、导入和自动保存本系统配置。";
  if (state.view === "snapshots") return "定期归档 CPAMC usage，沉淀长期历史。";
  if (state.view === "health") return "检查 CPAMC 连通性、管理接口和本地存储状态。";
  if (state.view === "audit") return "记录登录、配置、备份和导出操作。";
  return "管理当前视图的数据。";
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value || 0));
}

function compactNumber(value) {
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value || 0));
}

function formatDate(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString("zh-CN", { hour12: false });
}

function duration(seconds) {
  const s = Number(seconds || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function bytes(value) {
  const n = Number(value || 0);
  if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + " MB";
  if (n > 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}

function percent(value) {
  const number = Number(value || 0);
  return number.toFixed(1) + "%";
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function escapeHTML(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function maskMaybe(value) {
  const text = String(value || "");
  if (text.includes("*")) return text;
  if (text.length <= 10) return text;
  return `${text.slice(0, 3)}******${text.slice(-2)}`;
}

function canAdmin() {
  return state.user && state.user.role === "admin";
}

function canAdminViewer() {
  return state.user && (state.user.role === "admin" || state.user.role === "viewer");
}

function effectiveSettings() {
  return deepMerge(DEFAULT_SETTINGS, state.settings || {});
}

function appearance() {
  return effectiveSettings().appearance || DEFAULT_SETTINGS.appearance;
}

function deepMerge(base, patch) {
  const output = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === "object" && !Array.isArray(value) && output[key] && typeof output[key] === "object" && !Array.isArray(output[key])) {
      output[key] = deepMerge(output[key], value);
    } else if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

function currentTheme() {
  return state.theme || appearance().defaultTheme || "tech-dark";
}

function currentLanguage() {
  const configured = state.language || appearance().defaultLanguage || "auto";
  const language = configured === "auto" ? (appearance().defaultLanguage || "auto") : configured;
  if (language === "zh" || language === "en") return language;
  return (navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en";
}

function t(key) {
  const language = currentLanguage();
  return (DICT[language] && DICT[language][key]) || DICT.zh[key] || key;
}

function applyAppearance() {
  const a = appearance();
  const root = document.documentElement;
  root.dataset.theme = currentTheme();
  root.dataset.density = a.density || "comfortable";
  root.lang = currentLanguage() === "en" ? "en" : "zh-CN";
  root.style.setProperty("--radius", `${Math.max(4, Math.min(18, Number(a.radius || 8)))}px`);
  if (a.customTheme && a.customTheme.primary) {
    root.style.setProperty("--green", a.customTheme.primary);
    root.style.setProperty("--primary", a.customTheme.primary);
  }
  if (a.customTheme && a.customTheme.accent) {
    root.style.setProperty("--blue", a.customTheme.accent);
    root.style.setProperty("--accent", a.customTheme.accent);
  }
}

function themeOptions() {
  const options = [
    ["tech-dark", "Tech Dark"],
    ["graphite", "Graphite"],
    ["light", "Light"],
    ["aurora", "Aurora"],
    ["high-contrast", "High Contrast"],
  ];
  return options.map(([value, label]) => `<option value="${value}" ${currentTheme() === value ? "selected" : ""}>${label}</option>`).join("");
}

function languageOptions() {
  const selected = state.language || "auto";
  return [
    ["auto", "Auto"],
    ["zh", "中文"],
    ["en", "English"],
  ].map(([value, label]) => `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`).join("");
}

function titleForViewV2() {
  return titleForView();
}

function renderRangeToolbar() {
  const presets = [
    ["1h", currentLanguage() === "en" ? "1 hour" : "1 小时"],
    ["24h", currentLanguage() === "en" ? "24 hours" : "24 小时"],
    ["7d", currentLanguage() === "en" ? "7 days" : "7 天"],
    ["30d", currentLanguage() === "en" ? "30 days" : "30 天"],
    ["custom", currentLanguage() === "en" ? "Custom" : "自定义"],
  ];
  return `
    <section class="toolbar">
      <div class="segmented">
        ${presets.map(([value, label]) => `<button data-preset="${value}" class="${state.range.preset === value ? "active" : ""}">${escapeHTML(label)}</button>`).join("")}
      </div>
      <label><span>${currentLanguage() === "en" ? "Start" : "开始"}</span><input id="fromInput" type="datetime-local" value="${escapeHTML(state.range.from)}" ${state.range.preset !== "custom" ? "disabled" : ""} /></label>
      <label><span>${currentLanguage() === "en" ? "End" : "结束"}</span><input id="toInput" type="datetime-local" value="${escapeHTML(state.range.to)}" ${state.range.preset !== "custom" ? "disabled" : ""} /></label>
      <button id="applyRangeBtn">${currentLanguage() === "en" ? "Apply" : "应用"}</button>
      <button id="exportCsvBtn">${currentLanguage() === "en" ? "CSV" : "导出 CSV"}</button>
      <button id="exportJsonBtn">${currentLanguage() === "en" ? "JSON" : "导出 JSON"}</button>
    </section>
  `;
}

function renderDashboard() {
  const usage = state.usage || emptyUsage();
  const models = flattenModelRows(usage);
  const apis = flattenApiRows(usage);
  const breakdown = tokenBreakdown(usage);
  const successRate = usage.total_requests ? ((usage.success_count || 0) / usage.total_requests * 100).toFixed(1) : "0.0";
  const avgLatency = averageLatency(usage);
  const series = buildTimeSeries(usage);
  const topModels = models.slice(0, 8);

  chartRegistry.push({ id: "requestsChart", type: "line", data: series.map((item) => ({ label: item.label, value: item.requests })), color: cssVar("--green", "#20c788") });
  chartRegistry.push({ id: "tokensChart", type: "line", data: series.map((item) => ({ label: item.label, value: item.tokens })), color: cssVar("--purple", "#8b5cf6") });
  chartRegistry.push({ id: "modelBarChart", type: "bar", data: topModels.map((item) => ({ label: item.model, value: item.tokens })), color: cssVar("--blue", "#5fa8ff") });
  chartRegistry.push({ id: "tokenDonutChart", type: "donut", data: [
    { label: "Input", value: breakdown.input, color: "#9ca3af" },
    { label: "Output", value: breakdown.output, color: cssVar("--green", "#20c788") },
    { label: "Cached", value: breakdown.cached, color: cssVar("--orange", "#f59e0b") },
    { label: "Reasoning", value: breakdown.reasoning, color: cssVar("--purple", "#8b5cf6") },
  ] });

  return `
    ${renderRangeToolbar()}
    ${state.alerts.length ? `<section class="alert-strip">${state.alerts.slice(0, 3).map((alert) => `<div class="alert ${alert.level}"><strong>${escapeHTML(alert.label)}</strong><span>${escapeHTML(alert.message)}</span></div>`).join("")}</section>` : ""}
    <div class="grid cards">
      ${metricCard(currentLanguage() === "en" ? "Requests" : "总请求", formatNumber(usage.total_requests || 0), `${currentLanguage() === "en" ? "Success rate" : "成功率"} ${successRate}%`, "metric-green")}
      ${metricCard("Token", compactNumber(usage.total_tokens || 0), currentLanguage() === "en" ? "Input / output / cache / reasoning" : "输入 / 输出 / 缓存 / 思考", "metric-purple")}
      ${metricCard(currentLanguage() === "en" ? "Avg Latency" : "平均延迟", avgLatency ? avgLatency.toFixed(2) + "s" : "--", currentLanguage() === "en" ? "Estimated from request details" : "按请求明细估算", "metric-blue")}
      ${metricCard(currentLanguage() === "en" ? "Active Models" : "活跃模型", formatNumber(models.length), `${apis.length} API Key`, "metric-orange")}
    </div>
    <div class="grid chart-grid">
      ${chartPanel(currentLanguage() === "en" ? "Request Trend" : "请求趋势", "requestsChart")}
      ${chartPanel(currentLanguage() === "en" ? "Token Trend" : "Token 趋势", "tokensChart")}
      ${chartPanel(currentLanguage() === "en" ? "Model Token Ranking" : "模型 Token 排行", "modelBarChart")}
      ${chartPanel(currentLanguage() === "en" ? "Token Mix" : "Token 类型分布", "tokenDonutChart")}
    </div>
    ${renderActivityHeatmap()}
    <section class="section">
      <div class="section-head">
        <h2>${currentLanguage() === "en" ? "Model Ranking" : "模型排行榜"}</h2>
        <div class="table-tools">
          <input id="searchInput" value="${escapeHTML(state.search)}" placeholder="${currentLanguage() === "en" ? "Search model or key" : "搜索模型或 Key"}" />
          <select id="sortSelect">
            ${sortOption("tokens", currentLanguage() === "en" ? "By token" : "按 Token")}
            ${sortOption("requests", currentLanguage() === "en" ? "By requests" : "按请求数")}
            ${sortOption("latency", currentLanguage() === "en" ? "By latency" : "按平均延迟")}
            ${sortOption("failure", currentLanguage() === "en" ? "By failure rate" : "按失败率")}
          </select>
        </div>
      </div>
      ${renderModelTable(models)}
    </section>
    ${canAdmin() ? `
      <section class="section">
        <div class="section-head"><h2>API Key ${currentLanguage() === "en" ? "Ranking" : "排行"}</h2><span class="muted">${apis.length} Key</span></div>
        ${renderApiTable(apis)}
      </section>
      ${renderGroupSummary()}
    ` : ""}
  `;
}

function renderActivityHeatmap() {
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, requests: 0, tokens: 0 }));
  for (const row of flattenModelRows(state.usage || emptyUsage())) {
    for (const detail of row.details || []) {
      const date = new Date(detail.timestamp);
      if (Number.isNaN(date.getTime())) continue;
      const bucket = hours[date.getHours()];
      bucket.requests += 1;
      bucket.tokens += Number((detail.tokens || {}).total_tokens || 0);
    }
  }
  const max = Math.max(...hours.map((item) => item.requests), 1);
  return `
    <section class="section">
      <div class="section-head"><h2>${currentLanguage() === "en" ? "24h Activity Heatmap" : "24 小时活跃热力图"}</h2><span class="muted">${currentLanguage() === "en" ? "Based on request timestamps" : "按请求时间分布"}</span></div>
      <div class="heatmap">
        ${hours.map((item) => `<div class="heat-cell" style="--level:${item.requests / max}" title="${pad(item.hour)}:00 ${item.requests} requests"><strong>${pad(item.hour)}</strong><span>${formatNumber(item.requests)}</span></div>`).join("")}
      </div>
    </section>
  `;
}

function renderModelTable(rows) {
  const filtered = filterRows(rows, (row) => row.model);
  const sorted = sortModelRows(filtered);
  const page = paginate(sorted, state.page, 12);
  if (!page.rows.length) return `<div class="empty">${currentLanguage() === "en" ? "No model usage in the selected range." : "当前时间范围没有模型用量。"}</div>`;
  return `
    ${table([
      currentLanguage() === "en" ? "Model" : "模型",
      currentLanguage() === "en" ? "Requests" : "请求",
      "Token",
      currentLanguage() === "en" ? "Avg Latency" : "平均延迟",
      currentLanguage() === "en" ? "Failure" : "失败率",
      currentLanguage() === "en" ? "Input" : "输入",
      currentLanguage() === "en" ? "Output" : "输出",
      currentLanguage() === "en" ? "Cached" : "缓存",
      currentLanguage() === "en" ? "Reasoning" : "思考",
    ], page.rows.map((row) => [
      `<button class="linkish" data-model-detail="${escapeHTML(row.model)}">${escapeHTML(row.model)}</button>`,
      formatNumber(row.requests),
      formatNumber(row.tokens),
      row.avgLatency ? row.avgLatency.toFixed(2) + "s" : "--",
      row.failureRate.toFixed(1) + "%",
      formatNumber(row.input),
      formatNumber(row.output),
      formatNumber(row.cached),
      formatNumber(row.reasoning),
    ]))}
    ${pagination(page)}
  `;
}

function renderApiTable(rows) {
  const filtered = filterRows(rows, (row) => `${row.api} ${row.alias || ""}`);
  const sorted = filtered.sort((a, b) => b.tokens - a.tokens);
  if (!sorted.length) return `<div class="empty">${currentLanguage() === "en" ? "No API key usage yet." : "暂无 API Key 统计。"}</div>`;
  return table([
    currentLanguage() === "en" ? "Alias" : "别名",
    "API Key",
    currentLanguage() === "en" ? "Requests" : "请求",
    "Token",
    currentLanguage() === "en" ? "Models" : "模型数",
    currentLanguage() === "en" ? "Failure" : "失败率",
  ], sorted.map((row) => [
    escapeHTML(row.alias || "--"),
    `<button class="linkish" data-api-detail="${escapeHTML(row.api)}">${escapeHTML(maskMaybe(row.api))}</button>`,
    formatNumber(row.requests),
    formatNumber(row.tokens),
    formatNumber(row.modelCount),
    row.failureRate.toFixed(1) + "%",
  ]));
}

function renderGroupSummary() {
  if (!state.groups.length || !canAdmin()) return "";
  return `
    <section class="section">
      <div class="section-head"><h2>${currentLanguage() === "en" ? "Group Summary" : "分组统计"}</h2><span class="muted">${state.groups.length} ${currentLanguage() === "en" ? "groups" : "个分组"}</span></div>
      ${table([
        currentLanguage() === "en" ? "Group" : "分组",
        currentLanguage() === "en" ? "Users" : "用户",
        "Key",
        currentLanguage() === "en" ? "Requests" : "请求",
        "Token",
        currentLanguage() === "en" ? "Models" : "模型",
      ], state.groups.map((group) => [
        escapeHTML(group.name),
        formatNumber(group.users),
        formatNumber(group.apiKeys),
        formatNumber(group.requests),
        formatNumber(group.tokens),
        formatNumber(group.models),
      ]))}
    </section>
  `;
}

function renderModels() {
  const models = state.models || [];
  return `
    <section class="section">
      <div class="section-head">
        <h2>${currentLanguage() === "en" ? "Models Available To Current Key" : "当前 Key 可用模型"}</h2>
        <button id="loadModelsBtn">${currentLanguage() === "en" ? "Reload" : "重新读取"}</button>
      </div>
      ${models.length ? table([currentLanguage() === "en" ? "Model ID" : "模型 ID", currentLanguage() === "en" ? "Type" : "类型"], models.map((model) => [
        escapeHTML(model.id || model.name || "-"),
        escapeHTML(model.object || model.type || "-"),
      ])) : `<div class="empty">${currentLanguage() === "en" ? "Click reload to fetch the model list." : "点击“重新读取”获取模型列表。"}</div>`}
    </section>
  `;
}

function renderUsers() {
  if (!canAdmin()) return `<div class="empty">${currentLanguage() === "en" ? "Admin only." : "仅管理员可访问。"}</div>`;
  return `
    <div class="grid two">
      <section class="section wide-section">
        <div class="section-head"><h2>${currentLanguage() === "en" ? "Users" : "用户列表"}</h2><span class="muted">${state.users.length} ${currentLanguage() === "en" ? "users" : "人"}</span></div>
        ${state.users.length ? table([
          currentLanguage() === "en" ? "Name" : "名称",
          currentLanguage() === "en" ? "Group" : "分组",
          currentLanguage() === "en" ? "Note" : "备注",
          currentLanguage() === "en" ? "Role" : "角色",
          "Key",
          currentLanguage() === "en" ? "Limits" : "限额",
          currentLanguage() === "en" ? "Status" : "状态",
          currentLanguage() === "en" ? "Actions" : "操作",
        ], state.users.map((user) => [
          `<input data-user-name="${user.id}" value="${escapeHTML(user.displayName)}" />`,
          `<input data-user-group="${user.id}" value="${escapeHTML(user.group || "")}" placeholder="${currentLanguage() === "en" ? "Team / client" : "例如 测试组"}" />`,
          `<input data-user-note="${user.id}" value="${escapeHTML(user.note || "")}" placeholder="${currentLanguage() === "en" ? "Owner or purpose" : "负责人或用途"}" />`,
          `<select data-user-role="${user.id}">${roleOption("user", user.role)}${roleOption("viewer", user.role)}${roleOption("admin", user.role)}</select>`,
          renderUserKeys(user),
          renderLimitInputs(user),
          user.disabled ? `<span class="warn">${currentLanguage() === "en" ? "Disabled" : "禁用"}</span>` : `<span class="ok">${currentLanguage() === "en" ? "Enabled" : "启用"}</span>`,
          `<div class="actions"><button data-save-user="${user.id}">${currentLanguage() === "en" ? "Save" : "保存"}</button><button data-toggle-user="${user.id}">${user.disabled ? (currentLanguage() === "en" ? "Enable" : "启用") : (currentLanguage() === "en" ? "Disable" : "禁用")}</button><button class="danger" data-delete-user="${user.id}">${currentLanguage() === "en" ? "Delete" : "删除"}</button></div>`,
        ])) : `<div class="empty">${currentLanguage() === "en" ? "No local users yet." : "暂无用户。"}</div>`}
      </section>
      <section class="section">
        <div class="section-head"><h2>${currentLanguage() === "en" ? "Add Or Update User" : "添加或更新用户"}</h2></div>
        <form class="form-grid" id="addUserForm">
          <label><span class="muted">${currentLanguage() === "en" ? "Display name" : "显示名称"}</span><input name="displayName" placeholder="${currentLanguage() === "en" ? "For example Alice" : "例如 张三"}" /></label>
          <label><span class="muted">${currentLanguage() === "en" ? "Group" : "分组"}</span><input name="group" placeholder="${currentLanguage() === "en" ? "Production / Client A" : "例如 正式组 / 客户 A"}" /></label>
          <label><span class="muted">${currentLanguage() === "en" ? "Note" : "备注"}</span><input name="note" placeholder="${currentLanguage() === "en" ? "Owner or purpose" : "负责人或用途"}" /></label>
          <label><span class="muted">API Key</span><input name="apiKey" type="password" placeholder="sk-..." /></label>
          <label><span class="muted">${currentLanguage() === "en" ? "Role" : "角色"}</span><select name="role"><option value="user">${currentLanguage() === "en" ? "User" : "普通用户"}</option><option value="viewer">${currentLanguage() === "en" ? "Viewer" : "只读观察员"}</option><option value="admin">${currentLanguage() === "en" ? "Admin" : "管理员"}</option></select></label>
          <button class="primary" type="submit">${currentLanguage() === "en" ? "Save User" : "保存用户"}</button>
        </form>
        <div class="divider"></div>
        <div class="section-head"><h2>${currentLanguage() === "en" ? "Bind Extra Key" : "绑定附加 Key"}</h2></div>
        <form class="form-grid" id="addUserKeyForm">
          <label><span class="muted">${currentLanguage() === "en" ? "User" : "选择用户"}</span><select name="userId">${state.users.map((user) => `<option value="${user.id}">${escapeHTML(user.displayName)}</option>`).join("")}</select></label>
          <label><span class="muted">${currentLanguage() === "en" ? "Label" : "Key 标签"}</span><input name="label" placeholder="${currentLanguage() === "en" ? "Codex backup" : "例如 Codex 备用"}" /></label>
          <label><span class="muted">API Key</span><input name="apiKey" type="password" placeholder="sk-..." /></label>
          <button class="primary" type="submit">${currentLanguage() === "en" ? "Bind Key" : "绑定 Key"}</button>
        </form>
      </section>
    </div>
  `;
}

function renderUserKeys(user) {
  const keys = user.apiKeys || [];
  if (!keys.length) return escapeHTML(user.apiKeyPreview || "--");
  return `<div class="key-list">${keys.map((key) => `<span class="key-pill"><b>${escapeHTML(key.preview)}</b>${key.label ? `<small>${escapeHTML(key.label)}</small>` : ""}<button title="${currentLanguage() === "en" ? "Unbind" : "解绑"}" data-delete-user-key="${user.id}:${key.id}">x</button></span>`).join("")}</div>`;
}

function renderLimitInputs(user) {
  const limits = user.limits || {};
  return `
    <div class="limit-grid">
      <input data-limit="${user.id}:dailyTokens" value="${limits.dailyTokens || ""}" placeholder="${currentLanguage() === "en" ? "Daily tokens" : "日 Token"}" />
      <input data-limit="${user.id}:monthlyTokens" value="${limits.monthlyTokens || ""}" placeholder="${currentLanguage() === "en" ? "30d tokens" : "30 天 Token"}" />
      <input data-limit="${user.id}:dailyRequests" value="${limits.dailyRequests || ""}" placeholder="${currentLanguage() === "en" ? "Daily req" : "日请求"}" />
      <input data-limit="${user.id}:monthlyRequests" value="${limits.monthlyRequests || ""}" placeholder="${currentLanguage() === "en" ? "30d req" : "30 天请求"}" />
    </div>
  `;
}

function renderAlerts() {
  return `
    <div class="grid two">
      <section class="section">
        <div class="section-head"><h2>${currentLanguage() === "en" ? "Limit Alerts" : "预警事件"}</h2><button id="loadAlertsBtn">${t("refresh")}</button></div>
        ${state.alerts.length ? table([
          currentLanguage() === "en" ? "Level" : "等级",
          currentLanguage() === "en" ? "User" : "用户",
          currentLanguage() === "en" ? "Metric" : "项目",
          currentLanguage() === "en" ? "Used" : "已用",
          currentLanguage() === "en" ? "Limit" : "限额",
          currentLanguage() === "en" ? "Progress" : "进度",
        ], state.alerts.map((alert) => [
          alert.level === "danger" ? `<span class="warn">${currentLanguage() === "en" ? "Exceeded" : "超限"}</span>` : `<span class="ok">${currentLanguage() === "en" ? "Near" : "接近"}</span>`,
          escapeHTML(alert.user.displayName),
          escapeHTML(alert.label),
          formatNumber(alert.used),
          formatNumber(alert.limit),
          progressBar(alert.ratio),
        ])) : `<div class="empty">${currentLanguage() === "en" ? "No alerts. Set limits on users to monitor 80% and exceeded usage." : "暂无预警。给用户设置限额后，这里会展示达到 80% 或超限的项目。"}</div>`}
      </section>
      <section class="section">
        <div class="section-head"><h2>${currentLanguage() === "en" ? "User Usage Progress" : "用户用量进度"}</h2></div>
        ${state.alertUsers.length ? table([
          currentLanguage() === "en" ? "User" : "用户",
          currentLanguage() === "en" ? "Today Requests" : "今日请求",
          currentLanguage() === "en" ? "Today Tokens" : "今日 Token",
          currentLanguage() === "en" ? "30d Requests" : "30 天请求",
          currentLanguage() === "en" ? "30d Tokens" : "30 天 Token",
        ], state.alertUsers.map((row) => [
          escapeHTML(row.user.displayName),
          formatNumber(row.today.requests),
          formatNumber(row.today.tokens),
          formatNumber(row.month.requests),
          formatNumber(row.month.tokens),
        ])) : `<div class="empty">${currentLanguage() === "en" ? "No usage yet." : "暂无用户用量。"}</div>`}
      </section>
    </div>
    ${renderGroupSummary()}
  `;
}

function renderBackups() {
  return `
    <div class="grid two">
      <section class="section">
        <div class="section-head"><h2>${currentLanguage() === "en" ? "Backup Files" : "备份文件"}</h2><div class="actions"><button id="createBackupBtn">${currentLanguage() === "en" ? "Backup Now" : "立即备份"}</button><button id="exportBackupBtn">${currentLanguage() === "en" ? "Export" : "导出备份"}</button></div></div>
        ${state.backups.length ? table([
          currentLanguage() === "en" ? "File" : "文件",
          currentLanguage() === "en" ? "Size" : "大小",
          currentLanguage() === "en" ? "Time" : "时间",
          currentLanguage() === "en" ? "Actions" : "操作",
        ], state.backups.map((backup) => [
          escapeHTML(backup.fileName),
          bytes(backup.size),
          formatDate(backup.updatedAt),
          `<div class="actions"><button data-download-backup="${backup.fileName}">${currentLanguage() === "en" ? "Download" : "下载"}</button><button class="danger" data-delete-backup="${backup.fileName}">${currentLanguage() === "en" ? "Delete" : "删除"}</button></div>`,
        ])) : `<div class="empty">${currentLanguage() === "en" ? "No backup files." : "暂无备份文件。"}</div>`}
      </section>
      <section class="section">
        <div class="section-head"><h2>${currentLanguage() === "en" ? "Import Backup" : "导入备份"}</h2></div>
        <form class="form-grid" id="importBackupForm">
          <input name="file" type="file" accept="application/json,.json" />
          <label><span class="muted">${currentLanguage() === "en" ? "Import mode" : "导入模式"}</span><select name="mode"><option value="merge">${currentLanguage() === "en" ? "Merge" : "合并"}</option><option value="replace">${currentLanguage() === "en" ? "Replace" : "覆盖"}</option></select></label>
          <button class="primary" type="submit">${currentLanguage() === "en" ? "Import" : "导入"}</button>
          <p class="muted">${currentLanguage() === "en" ? "Backups include local users, roles, aliases, notes and system settings, but never the CPAMC management key from .env." : "备份包含本地用户、角色、别名、备注和系统设置，不包含 .env 中的 CPAMC 管理密钥。"}</p>
        </form>
      </section>
    </div>
  `;
}

function renderSnapshots() {
  return `
    <section class="section">
      <div class="section-head"><h2>CPAMC Usage ${currentLanguage() === "en" ? "Snapshots" : "快照"}</h2><div class="actions"><button id="createSnapshotBtn">${currentLanguage() === "en" ? "Create Snapshot" : "立即创建快照"}</button></div></div>
      <p class="muted">${currentLanguage() === "en" ? "Snapshots archive CPAMC usage for migration and long-term history." : "快照会保存 CPAMC 当前 usage 聚合数据，用于重启、迁移或长期历史留存。"}</p>
      ${state.snapshots.length ? table([
        currentLanguage() === "en" ? "File" : "文件",
        currentLanguage() === "en" ? "Reason" : "原因",
        "Key",
        currentLanguage() === "en" ? "Requests" : "请求",
        "Token",
        currentLanguage() === "en" ? "Size" : "大小",
        currentLanguage() === "en" ? "Time" : "时间",
        currentLanguage() === "en" ? "Actions" : "操作",
      ], state.snapshots.map((snapshot) => [
        escapeHTML(snapshot.fileName),
        escapeHTML(snapshot.reason || ""),
        formatNumber(snapshot.apiKeyCount || 0),
        formatNumber(snapshot.totalRequests || 0),
        formatNumber(snapshot.totalTokens || 0),
        bytes(snapshot.size),
        formatDate(snapshot.updatedAt),
        `<div class="actions"><button data-download-snapshot="${snapshot.fileName}">${currentLanguage() === "en" ? "Download" : "下载"}</button><button class="danger" data-delete-snapshot="${snapshot.fileName}">${currentLanguage() === "en" ? "Delete" : "删除"}</button></div>`,
      ])) : `<div class="empty">${currentLanguage() === "en" ? "No snapshots." : "暂无快照文件。"}</div>`}
    </section>
  `;
}

function renderInsights() {
  const data = state.insights;
  if (!data) return `<section class="section"><button id="loadInsightsBtn">${currentLanguage() === "en" ? "Load Insights" : "加载洞察"}</button></section>`;
  const costs = data.costs || { byModel: [], total: 0, currency: "USD" };
  const efficiency = (data.efficiency || []).slice(0, 10);
  chartRegistry.push({ id: "costChart", type: "bar", data: (costs.byModel || []).slice(0, 8).map((item) => ({ label: item.model, value: item.cost })), color: cssVar("--orange", "#f59e0b") });
  chartRegistry.push({ id: "efficiencyChart", type: "bar", data: efficiency.map((item) => ({ label: item.model, value: item.score })), color: cssVar("--green", "#20c788") });
  return `
    ${renderRangeToolbar()}
    <div class="grid cards">
      ${metricCard(currentLanguage() === "en" ? "Estimated Cost" : "预估成本", currencyAmount(costs.total, costs.currency), currentLanguage() === "en" ? "Based on configured model prices" : "按设置中的模型价格估算", "metric-orange")}
      ${metricCard(currentLanguage() === "en" ? "Anomalies" : "异常信号", formatNumber((data.anomalies || []).length), currentLanguage() === "en" ? "Failure, latency and concentration" : "失败率、延迟和用量集中度", "metric-red")}
      ${metricCard(currentLanguage() === "en" ? "Models" : "模型数", formatNumber((data.summary || {}).models || 0), `${formatNumber((data.summary || {}).apiKeys || 0)} Key`, "metric-blue")}
      ${metricCard("Token", compactNumber((data.summary || {}).totalTokens || 0), `${formatNumber((data.summary || {}).totalRequests || 0)} ${currentLanguage() === "en" ? "requests" : "次请求"}`, "metric-purple")}
    </div>
    <div class="grid chart-grid">
      ${chartPanel(currentLanguage() === "en" ? "Cost By Model" : "模型成本估算", "costChart")}
      ${chartPanel(currentLanguage() === "en" ? "Model Efficiency Score" : "模型效率评分", "efficiencyChart")}
    </div>
    <div class="grid two">
      <section class="section">
        <div class="section-head"><h2>${currentLanguage() === "en" ? "Anomaly Radar" : "异常雷达"}</h2><button id="reportBtn">${currentLanguage() === "en" ? "Daily Report" : "生成日报"}</button></div>
        ${(data.anomalies || []).length ? `<div class="insight-list">${data.anomalies.map((item) => `<article class="insight ${item.level || "info"}"><strong>${escapeHTML(item.title)}</strong><span>${escapeHTML(item.message)}</span></article>`).join("")}</div>` : `<div class="empty">${currentLanguage() === "en" ? "No obvious anomalies in this range." : "当前时间范围没有明显异常。"}</div>`}
      </section>
      <section class="section">
        <div class="section-head"><h2>${currentLanguage() === "en" ? "Daily Report" : "日报"}</h2><div class="actions"><button id="notifyReportBtn">${currentLanguage() === "en" ? "Send Webhook" : "发送通知"}</button></div></div>
        ${renderDailyReport()}
      </section>
    </div>
    <section class="section">
      <div class="section-head"><h2>${currentLanguage() === "en" ? "User Profiles" : "用户画像"}</h2><span class="muted">${currentLanguage() === "en" ? "Top users by token usage" : "按 Token 用量排序"}</span></div>
      ${(data.profiles || []).length ? table([
        currentLanguage() === "en" ? "User" : "用户",
        currentLanguage() === "en" ? "Group" : "分组",
        currentLanguage() === "en" ? "Requests" : "请求",
        "Token",
        currentLanguage() === "en" ? "Peak Hour" : "高峰时段",
        currentLanguage() === "en" ? "Top Models" : "常用模型",
      ], data.profiles.map((item) => [
        escapeHTML((item.user || {}).displayName || "--"),
        escapeHTML((item.user || {}).group || "--"),
        formatNumber(item.requests),
        formatNumber(item.tokens),
        item.activeHour == null ? "--" : `${pad(item.activeHour)}:00`,
        escapeHTML((item.topModels || []).map((model) => model.model).join(", ") || "--"),
      ])) : `<div class="empty">${currentLanguage() === "en" ? "No user profile data." : "暂无用户画像数据。"}</div>`}
    </section>
  `;
}

function renderDailyReport() {
  const report = state.report;
  if (!report) return `<div class="empty">${currentLanguage() === "en" ? "Generate a daily report to preview today's summary, top models and anomalies." : "生成日报后会预览今日汇总、模型排行和异常信号。"}</div>`;
  const summary = report.summary || {};
  return `
    <div class="mini-grid">
      ${metricCard(currentLanguage() === "en" ? "Requests" : "请求", formatNumber(summary.requests || 0), "")}
      ${metricCard("Token", formatNumber(summary.tokens || 0), "")}
    </div>
    <div class="divider"></div>
    ${table([currentLanguage() === "en" ? "Top Model" : "热门模型", currentLanguage() === "en" ? "Requests" : "请求", "Token"], (report.topModels || []).slice(0, 5).map((row) => [
      escapeHTML(row.model),
      formatNumber(row.requests),
      formatNumber(row.tokens),
    ]))}
  `;
}

function renderSessions() {
  if (!canAdminViewer()) return `<div class="empty">${currentLanguage() === "en" ? "Admin or viewer only." : "仅管理员或只读观察员可访问。"}</div>`;
  return `
    <section class="section">
      <div class="section-head"><h2>${currentLanguage() === "en" ? "Active Sessions" : "在线会话"}</h2><button id="loadSessionsBtn">${t("refresh")}</button></div>
      ${state.sessions.length ? table([
        "ID",
        currentLanguage() === "en" ? "User" : "用户",
        currentLanguage() === "en" ? "Role" : "角色",
        "API Key",
        currentLanguage() === "en" ? "Created" : "创建时间",
        currentLanguage() === "en" ? "Last Seen" : "最近活跃",
        currentLanguage() === "en" ? "Expires" : "过期时间",
        currentLanguage() === "en" ? "Actions" : "操作",
      ], state.sessions.map((item) => [
        `<code>${escapeHTML(item.id)}</code>`,
        escapeHTML((item.user || {}).displayName || "--"),
        roleBadge((item.user || {}).role || "user"),
        escapeHTML(item.apiKeyPreview || "--"),
        formatDate(item.createdAt),
        formatDate(item.lastSeenAt),
        formatDate(item.expiresAt),
        canAdmin() ? `<button class="danger" data-revoke-session="${item.id}">${currentLanguage() === "en" ? "Revoke" : "踢下线"}</button>` : `<span class="muted">--</span>`,
      ])) : `<div class="empty">${currentLanguage() === "en" ? "No active sessions." : "暂无在线会话。"}</div>`}
    </section>
  `;
}

function renderSettings() {
  if (!canAdmin()) return `<div class="empty">${currentLanguage() === "en" ? "Settings are admin only." : "设置仅管理员可编辑。"}</div>`;
  const settings = effectiveSettings();
  const a = settings.appearance || {};
  const notifications = settings.notifications || {};
  const permissions = settings.permissions || {};
  const automation = settings.automation || {};
  const pricing = settings.pricing || {};
  return `
    <form id="settingsForm">
      <div class="grid two">
        <section class="section">
          <div class="section-head"><h2>${currentLanguage() === "en" ? "Brand And Theme" : "品牌与主题"}</h2></div>
          <div class="form-grid">
            <label><span>${currentLanguage() === "en" ? "App name" : "应用名称"}</span><input name="appName" value="${escapeHTML(a.appName || "")}" /></label>
            <label><span>${currentLanguage() === "en" ? "Logo text" : "Logo 文案"}</span><input name="logoText" maxlength="4" value="${escapeHTML(a.logoText || "")}" /></label>
            <label><span>${currentLanguage() === "en" ? "Default theme" : "默认主题"}</span><select name="defaultTheme">${themeOptionsFor(a.defaultTheme || "tech-dark")}</select></label>
            <label><span>${currentLanguage() === "en" ? "Default language" : "默认语言"}</span><select name="defaultLanguage">${languageOptionsFor(a.defaultLanguage || "auto")}</select></label>
            <label><span>${currentLanguage() === "en" ? "Density" : "密度"}</span><select name="density">${densityOptions(a.density || "comfortable")}</select></label>
            <label><span>${currentLanguage() === "en" ? "Radius" : "圆角"}</span><input name="radius" type="number" min="4" max="18" value="${escapeHTML(a.radius || 8)}" /></label>
            <label><span>${currentLanguage() === "en" ? "Primary color" : "主色"}</span><input name="primary" type="color" value="${escapeHTML((a.customTheme || {}).primary || "#20c788")}" /></label>
            <label><span>${currentLanguage() === "en" ? "Accent color" : "强调色"}</span><input name="accent" type="color" value="${escapeHTML((a.customTheme || {}).accent || "#5fa8ff")}" /></label>
          </div>
        </section>
        <section class="section">
          <div class="section-head"><h2>${currentLanguage() === "en" ? "Notifications And Automation" : "通知与自动化"}</h2><button type="button" id="testWebhookBtn">${currentLanguage() === "en" ? "Test" : "测试通知"}</button></div>
          <div class="form-grid">
            ${checkboxField("webhookEnabled", notifications.webhookEnabled, currentLanguage() === "en" ? "Enable webhook" : "启用 Webhook")}
            <label><span>Webhook URL</span><input name="webhookUrl" value="${escapeHTML(notifications.webhookUrl || "")}" placeholder="https://..." /></label>
            ${checkboxField("dailyReportEnabled", notifications.dailyReportEnabled, currentLanguage() === "en" ? "Daily report notification" : "开启日报通知")}
            <label><span>${currentLanguage() === "en" ? "Daily report hour" : "日报发送小时"}</span><input name="dailyReportHour" type="number" min="0" max="23" value="${escapeHTML(notifications.dailyReportHour ?? 9)}" /></label>
            ${checkboxField("anomalyEnabled", notifications.anomalyEnabled, currentLanguage() === "en" ? "Anomaly notification" : "开启异常通知")}
            ${checkboxField("autoDisableOnLimitExceeded", automation.autoDisableOnLimitExceeded, currentLanguage() === "en" ? "Auto-disable users after limits are exceeded" : "超限后自动禁用普通用户")}
          </div>
        </section>
      </div>
      <div class="grid two">
        <section class="section">
          <div class="section-head"><h2>${currentLanguage() === "en" ? "Permissions" : "权限策略"}</h2></div>
          <div class="form-grid">
            ${checkboxField("allowViewerExport", permissions.allowViewerExport, currentLanguage() === "en" ? "Viewer can export usage" : "只读观察员允许导出用量")}
            <p class="muted">${currentLanguage() === "en" ? "Roles: admin can edit everything, viewer can see global dashboards, user only sees own key." : "角色说明：admin 可编辑全部，viewer 只能看全局数据，user 只能看自己的 Key。"}</p>
          </div>
        </section>
        <section class="section">
          <div class="section-head"><h2>${currentLanguage() === "en" ? "Pricing" : "模型价格"}</h2></div>
          <div class="form-grid">
            <label><span>${currentLanguage() === "en" ? "Currency" : "货币"}</span><input name="currency" value="${escapeHTML(pricing.currency || "USD")}" /></label>
            <label><span>${currentLanguage() === "en" ? "Model prices JSON" : "模型价格 JSON"}</span><textarea name="pricingModels" rows="12" spellcheck="false">${escapeHTML(JSON.stringify(pricing.models || {}, null, 2))}</textarea></label>
            <p class="muted">${currentLanguage() === "en" ? "Format: model -> inputPerMTok/outputPerMTok/cachedPerMTok/reasoningPerMTok." : "格式：模型名 -> inputPerMTok/outputPerMTok/cachedPerMTok/reasoningPerMTok，单位为每百万 Token。"}</p>
          </div>
        </section>
      </div>
      <section class="section settings-savebar">
        <button class="primary" type="submit">${currentLanguage() === "en" ? "Save Settings" : "保存设置"}</button>
      </section>
    </form>
  `;
}

function renderServerHealth() {
  const status = state.status;
  if (!status) return `<section class="section"><button id="loadStatusBtn">${currentLanguage() === "en" ? "Check Server" : "检查系统状态"}</button></section>`;
  const server = status.server || {};
  const cpu = server.cpu || {};
  const memory = server.memory || {};
  const processInfo = server.process || {};
  const processMemory = processInfo.memory || {};
  const disks = server.disks || [];
  return `
    <div class="grid cards">
      ${metricCard(currentLanguage() === "en" ? "System" : "系统状态", status.ok ? (currentLanguage() === "en" ? "OK" : "正常") : (currentLanguage() === "en" ? "Error" : "异常"), `Node ${status.app.node}`, "metric-green")}
      ${metricCard("CPU", percent(cpu.usage_percent), `${cpu.cores || 0} ${currentLanguage() === "en" ? "cores" : "核"}`, "metric-blue")}
      ${metricCard(currentLanguage() === "en" ? "Memory" : "内存", percent(memory.used_percent), `${bytes(memory.used || 0)} / ${bytes(memory.total || 0)}`, "metric-purple")}
      ${metricCard(currentLanguage() === "en" ? "App Uptime" : "应用运行", duration(status.app.uptime_seconds), currentLanguage() === "en" ? "Current process" : "当前进程", "metric-orange")}
    </div>
    <section class="section">
      <div class="section-head"><h2>${currentLanguage() === "en" ? "Live Server Parameters" : "服务器参数"}</h2><button id="loadStatusBtn">${t("refresh")}</button></div>
      <div class="status-bars">
        ${statusBar("CPU", cpu.usage_percent || 0)}
        ${statusBar(currentLanguage() === "en" ? "Memory" : "内存", memory.used_percent || 0)}
        ${statusBar(currentLanguage() === "en" ? "Process Heap" : "进程 Heap", processMemory.heap_total ? processMemory.heap_used / processMemory.heap_total * 100 : 0)}
      </div>
      ${table([currentLanguage() === "en" ? "Item" : "项目", currentLanguage() === "en" ? "Value" : "值"], [
        [currentLanguage() === "en" ? "Hostname" : "主机名", escapeHTML(server.hostname || "--")],
        [currentLanguage() === "en" ? "System" : "系统", escapeHTML(`${server.type || ""} ${server.release || ""} ${server.arch || ""}`.trim())],
        ["CPU", escapeHTML(cpu.model || "--")],
        [currentLanguage() === "en" ? "Timezone" : "时区", escapeHTML(server.timezone || "--")],
        [currentLanguage() === "en" ? "Current time" : "当前时间", formatDate(server.current_time)],
        ["PID", formatNumber(processInfo.pid || 0)],
        [currentLanguage() === "en" ? "Working dir" : "工作目录", `<code>${escapeHTML(processInfo.cwd || "")}</code>`],
      ])}
    </section>
    <section class="section">
      <div class="section-head"><h2>${currentLanguage() === "en" ? "Disk Status" : "磁盘状态"}</h2><span class="muted">${disks.length} ${currentLanguage() === "en" ? "volumes" : "个卷"}</span></div>
      ${disks.length ? table([
        currentLanguage() === "en" ? "Disk" : "磁盘",
        currentLanguage() === "en" ? "File system" : "文件系统",
        currentLanguage() === "en" ? "Used" : "已用",
        currentLanguage() === "en" ? "Free" : "可用",
        currentLanguage() === "en" ? "Total" : "总容量",
        currentLanguage() === "en" ? "Usage" : "占用",
      ], disks.map((disk) => [
        escapeHTML([disk.name || disk.mount || "--", disk.label ? `(${disk.label})` : ""].join(" ")),
        escapeHTML(disk.filesystem || "--"),
        bytes(disk.used || 0),
        bytes(disk.free || 0),
        bytes(disk.total || 0),
        progressBar((disk.used_percent || 0) / 100),
      ])) : `<div class="empty">${currentLanguage() === "en" ? "Disk metrics unavailable." : "未读取到磁盘数据。"}</div>`}
    </section>
    <section class="section">
      <div class="section-head"><h2>${currentLanguage() === "en" ? "Application Storage" : "应用存储"}</h2></div>
      ${table([currentLanguage() === "en" ? "Item" : "项目", currentLanguage() === "en" ? "Value" : "值"], [
        [currentLanguage() === "en" ? "Users" : "用户数", formatNumber(status.storage.user_count)],
        [currentLanguage() === "en" ? "Backups" : "备份数", formatNumber(status.storage.backup_count)],
        [currentLanguage() === "en" ? "Usage snapshots" : "Usage 快照数", formatNumber(status.storage.usage_snapshot_count || 0)],
        [currentLanguage() === "en" ? "Recent audit events" : "近期审计事件", formatNumber(status.storage.audit_events_recent)],
        ["CPAMC Requests", formatNumber(status.cpamc.total_requests)],
        ["CPAMC Token", formatNumber(status.cpamc.total_tokens)],
      ])}
    </section>
  `;
}

function renderAudit() {
  return `
    <section class="section">
      <div class="section-head"><h2>${currentLanguage() === "en" ? "Audit Log" : "审计日志"}</h2><button id="loadAuditBtn">${t("refresh")}</button></div>
      ${state.audit.length ? table([
        currentLanguage() === "en" ? "Time" : "时间",
        currentLanguage() === "en" ? "Action" : "动作",
        currentLanguage() === "en" ? "Actor" : "操作者",
        currentLanguage() === "en" ? "Details" : "详情",
      ], state.audit.map((event) => [
        formatDate(event.timestamp),
        escapeHTML(event.action),
        escapeHTML(event.actor ? `${event.actor.displayName} (${event.actor.role})` : "system"),
        `<code>${escapeHTML(JSON.stringify(event.details || {}))}</code>`,
      ])) : `<div class="empty">${currentLanguage() === "en" ? "No audit events." : "暂无审计事件。"}</div>`}
    </section>
  `;
}

function renderProfile() {
  return `
    <section class="section profile-panel">
      <div class="section-head"><h2>${currentLanguage() === "en" ? "Profile" : "个人资料"}</h2></div>
      <form class="form-grid" id="profileForm">
        <label><span class="muted">${currentLanguage() === "en" ? "Display name" : "显示名称"}</span><input name="displayName" value="${escapeHTML(state.user.displayName)}" /></label>
        <label><span class="muted">${currentLanguage() === "en" ? "Note" : "备注"}</span><input name="note" value="${escapeHTML(state.user.note || "")}" placeholder="${currentLanguage() === "en" ? "Purpose or owner" : "用途或负责人"}" /></label>
        <label><span class="muted">API Key</span><input value="${escapeHTML(state.user.apiKeyPreview)}" disabled /></label>
        <label><span class="muted">${currentLanguage() === "en" ? "Role" : "角色"}</span><input value="${escapeHTML(state.user.role)}" disabled /></label>
        <button class="primary" type="submit">${currentLanguage() === "en" ? "Save Profile" : "保存资料"}</button>
      </form>
    </section>
  `;
}

function renderDrawer() {
  const usage = state.usage || emptyUsage();
  const title = state.drawer.type === "model" ? state.drawer.value : (state.aliases[state.drawer.value] || maskMaybe(state.drawer.value));
  const details = state.drawer.type === "model"
    ? detailsForModel(usage, state.drawer.value)
    : detailsForApi(usage, state.drawer.value);
  const breakdown = details.reduce((acc, item) => {
    const tokens = item.tokens || {};
    acc.input += Number(tokens.input_tokens || 0);
    acc.output += Number(tokens.output_tokens || 0);
    acc.cached += Number(tokens.cached_tokens || 0);
    acc.reasoning += Number(tokens.reasoning_tokens || 0);
    acc.total += Number(tokens.total_tokens || 0);
    return acc;
  }, { input: 0, output: 0, cached: 0, reasoning: 0, total: 0 });
  return `
    <aside class="drawer">
      <div class="drawer-head">
        <div><h2>${escapeHTML(title)}</h2><p class="muted">${details.length} ${currentLanguage() === "en" ? "request details" : "条请求明细"}</p></div>
        <button id="closeDrawerBtn">${currentLanguage() === "en" ? "Close" : "关闭"}</button>
      </div>
      <div class="mini-grid">
        ${metricCard(currentLanguage() === "en" ? "Requests" : "请求", formatNumber(details.length), "")}
        ${metricCard("Token", formatNumber(breakdown.total), "")}
      </div>
      ${table([
        currentLanguage() === "en" ? "Time" : "时间",
        currentLanguage() === "en" ? "Model" : "模型",
        "API Key",
        "Token",
        currentLanguage() === "en" ? "Latency" : "延迟",
        currentLanguage() === "en" ? "Status" : "状态",
      ], details.slice(0, 100).map((item) => [
        formatDate(item.timestamp),
        escapeHTML(item.model),
        escapeHTML(maskMaybe(item.api)),
        formatNumber((item.tokens || {}).total_tokens || 0),
        item.latency_ms ? (item.latency_ms / 1000).toFixed(2) + "s" : "--",
        item.failed ? `<span class="warn">${currentLanguage() === "en" ? "Failed" : "失败"}</span>` : `<span class="ok">${currentLanguage() === "en" ? "OK" : "成功"}</span>`,
      ]))}
    </aside>
  `;
}

function titleForView() {
  return {
    dashboard: currentLanguage() === "en" ? "Usage Dashboard" : "用量仪表盘",
    models: currentLanguage() === "en" ? "Available Models" : "可用模型",
    insights: currentLanguage() === "en" ? "Intelligent Insights" : "智能洞察",
    users: currentLanguage() === "en" ? "User Management" : "用户管理",
    alerts: currentLanguage() === "en" ? "Limits And Alerts" : "限额预警",
    backups: currentLanguage() === "en" ? "Backup And Restore" : "备份恢复",
    snapshots: currentLanguage() === "en" ? "Usage Snapshots" : "使用快照",
    sessions: currentLanguage() === "en" ? "Session Center" : "会话中心",
    health: currentLanguage() === "en" ? "Server Status" : "服务器状态",
    audit: currentLanguage() === "en" ? "Audit Log" : "审计日志",
    settings: currentLanguage() === "en" ? "System Settings" : "系统设置",
    profile: currentLanguage() === "en" ? "Profile" : "个人资料",
  }[state.view] || (currentLanguage() === "en" ? "Usage Dashboard" : "用量仪表盘");
}

function subtitleForView() {
  const adminText = currentLanguage() === "en"
    ? "Global API key, model, token, latency and risk overview."
    : "全局 API Key、模型、Token、延迟和风险概览。";
  const userText = currentLanguage() === "en"
    ? "Current API key model usage and token consumption."
    : "当前 API Key 的模型和 Token 用量。";
  const map = {
    dashboard: canAdminViewer() ? adminText : userText,
    insights: currentLanguage() === "en" ? "Cost estimate, anomaly radar, efficiency scores and daily report." : "成本估算、异常雷达、效率评分和日报。",
    users: currentLanguage() === "en" ? "Edit aliases, groups, roles, notes, keys and usage limits." : "编辑别名、分组、角色、备注、Key 和用量限额。",
    alerts: currentLanguage() === "en" ? "Monitor user limits near 80% or exceeded." : "按用户限额监控接近 80% 和超限的风险。",
    backups: currentLanguage() === "en" ? "Export, import and automatically preserve local configuration." : "导出、导入和自动保存本地配置。",
    snapshots: currentLanguage() === "en" ? "Archive CPAMC usage for long-term history." : "定期归档 CPAMC usage，沉淀长期历史。",
    sessions: currentLanguage() === "en" ? "Review active logins and revoke sessions when needed." : "查看当前在线登录，并按需踢下线。",
    health: currentLanguage() === "en" ? "Inspect CPAMC connectivity, CPU, memory, disk and process state." : "检查 CPAMC 连通性、CPU、内存、磁盘和进程状态。",
    audit: currentLanguage() === "en" ? "Record logins, settings, backups, exports and management actions." : "记录登录、配置、备份、导出和管理操作。",
    settings: currentLanguage() === "en" ? "Customize theme, language, pricing, notifications and permissions." : "自定义主题、语言、价格、通知和权限策略。",
  };
  return map[state.view] || (currentLanguage() === "en" ? "Manage current view data." : "管理当前视图的数据。");
}

function bindEnhancedEvents() {
  on("#themeSelect", "change", (event) => {
    state.theme = event.target.value;
    localStorage.setItem("cpamc_theme", state.theme);
    applyAppearance();
    render();
  });
  on("#languageSelect", "change", (event) => {
    state.language = event.target.value;
    localStorage.setItem("cpamc_language", state.language);
    applyAppearance();
    render();
  });
  on("#fullscreenBtn", "click", () => {
    state.fullscreen = !state.fullscreen;
    render();
  });
  on("#loadInsightsBtn", "click", async () => {
    await loadInsights();
    render();
  });
  on("#reportBtn", "click", async () => {
    await loadDailyReport(false);
    render();
  });
  on("#notifyReportBtn", "click", async () => {
    await loadDailyReport(true);
    alert(currentLanguage() === "en" ? "Report sent or queued. Check notification settings for result." : "日报已生成并尝试发送，请在通知配置中查看结果。");
    render();
  });
  on("#loadSessionsBtn", "click", async () => {
    await loadSessions();
    render();
  });
  document.querySelectorAll("[data-revoke-session]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!confirm(currentLanguage() === "en" ? "Revoke this session?" : "确认踢掉这个会话？")) return;
      await api(`/api/sessions/${encodeURIComponent(button.dataset.revokeSession)}`, { method: "DELETE" });
      await loadSessions();
      render();
    });
  });
  on("#settingsForm", "submit", onSettingsSave);
  on("#testWebhookBtn", "click", onWebhookTest);
}

async function onSettingsSave(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  let models = {};
  try {
    models = JSON.parse(String(form.get("pricingModels") || "{}"));
  } catch {
    state.error = currentLanguage() === "en" ? "Model prices JSON is invalid." : "模型价格 JSON 格式不正确。";
    render();
    return;
  }
  const payload = {
    appearance: {
      appName: String(form.get("appName") || "").trim() || "CPAMC Sidecar",
      logoText: String(form.get("logoText") || "C").trim().slice(0, 4) || "C",
      defaultTheme: String(form.get("defaultTheme") || "tech-dark"),
      defaultLanguage: String(form.get("defaultLanguage") || "auto"),
      density: String(form.get("density") || "comfortable"),
      radius: Number(form.get("radius") || 8),
      customTheme: {
        primary: String(form.get("primary") || "#20c788"),
        accent: String(form.get("accent") || "#5fa8ff"),
      },
    },
    permissions: {
      allowViewerExport: form.get("allowViewerExport") === "on",
    },
    pricing: {
      currency: String(form.get("currency") || "USD").trim().toUpperCase() || "USD",
      models,
    },
    notifications: {
      webhookEnabled: form.get("webhookEnabled") === "on",
      webhookUrl: String(form.get("webhookUrl") || "").trim(),
      dailyReportEnabled: form.get("dailyReportEnabled") === "on",
      dailyReportHour: Number(form.get("dailyReportHour") || 9),
      anomalyEnabled: form.get("anomalyEnabled") === "on",
    },
    automation: {
      autoDisableOnLimitExceeded: form.get("autoDisableOnLimitExceeded") === "on",
    },
  };
  const result = await api("/api/settings", { method: "PATCH", body: { settings: payload } });
  state.settings = result.settings;
  state.error = "";
  applyAppearance();
  alert(currentLanguage() === "en" ? "Settings saved." : "设置已保存。");
  render();
}

async function onWebhookTest() {
  try {
    const result = await api("/api/notifications/test", { method: "POST" });
    alert(result.ok ? (currentLanguage() === "en" ? "Webhook test sent." : "测试通知已发送。") : `${currentLanguage() === "en" ? "Webhook skipped or failed" : "通知跳过或失败"}: ${result.reason || result.error || result.status || ""}`);
  } catch (err) {
    alert(err.message);
  }
}

async function onLogin(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  state.error = "";
  try {
    const result = await api("/api/login", {
      method: "POST",
      body: { apiKey: form.get("apiKey") },
      auth: false,
    });
    state.token = result.token;
    state.user = result.user;
    state.settings = result.settings || state.settings;
    localStorage.setItem("cpamc_sidecar_token", state.token);
    applyAppearance();
    await refreshAll();
  } catch (err) {
    state.error = err.message;
    render();
  }
}

async function api(url, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (options.auth !== false && state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || `Request failed: ${response.status}`);
  return data;
}

async function downloadFile(url, fallbackName) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${state.token}` } });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.message || data.error || (currentLanguage() === "en" ? "Download failed." : "下载失败。"));
  }
  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition") || "";
  const match = disposition.match(/filename="([^"]+)"/);
  const name = match ? match[1] : fallbackName;
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.click();
  URL.revokeObjectURL(href);
}

function chartPanel(title, id) {
  return `<section class="section chart-panel"><div class="section-head"><h2>${escapeHTML(title)}</h2></div><canvas id="${id}"></canvas></section>`;
}

function metricCard(label, value, hint, tone) {
  return `<article class="card ${tone || ""}"><span>${escapeHTML(label)}</span><strong>${value}</strong><small>${escapeHTML(hint || "")}</small></article>`;
}

function pagination(page) {
  if (page.totalPages <= 1) return "";
  const ofText = currentLanguage() === "en" ? `of ${page.total}` : `共 ${page.total} 条`;
  return `<div class="pagination"><span>${page.page}/${page.totalPages} ${ofText}</span><button data-page="${page.page - 1}" ${page.page <= 1 ? "disabled" : ""}>${currentLanguage() === "en" ? "Previous" : "上一页"}</button><button data-page="${page.page + 1}" ${page.page >= page.totalPages ? "disabled" : ""}>${currentLanguage() === "en" ? "Next" : "下一页"}</button></div>`;
}

function drawBarChart(ctx, rect, chart) {
  const data = chart.data || [];
  drawChartFrame(ctx, rect);
  if (!data.length) return drawNoData(ctx, rect);
  const max = Math.max(...data.map((p) => p.value), 1);
  const barH = Math.max(8, (rect.height - 36) / data.length - 7);
  data.forEach((p, index) => {
    const y = 20 + index * (barH + 7);
    const w = (rect.width - 128) * (p.value / max);
    ctx.fillStyle = chartBg();
    ctx.fillRect(110, y, rect.width - 126, barH);
    ctx.fillStyle = chart.color;
    ctx.fillRect(110, y, Math.max(2, w), barH);
    ctx.fillStyle = cssVar("--muted", "#a8b0bf");
    ctx.font = "11px Segoe UI";
    ctx.fillText(String(p.label).slice(0, 16), 10, y + barH - 1);
  });
}

function drawDonutChart(ctx, rect, chart) {
  const data = (chart.data || []).filter((p) => p.value > 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  if (!data.length) return drawNoData(ctx, rect);
  const total = data.reduce((sum, p) => sum + p.value, 0);
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  const radius = Math.min(rect.width, rect.height) / 2 - 18;
  let start = -Math.PI / 2;
  data.forEach((p) => {
    const angle = (p.value / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.strokeStyle = p.color;
    ctx.lineWidth = 18;
    ctx.arc(cx, cy, radius, start, start + angle);
    ctx.stroke();
    start += angle;
  });
  ctx.fillStyle = cssVar("--text", "#f3f6fb");
  ctx.font = "700 18px Segoe UI";
  ctx.textAlign = "center";
  ctx.fillText(compactNumber(total), cx, cy + 6);
  ctx.textAlign = "left";
}

function drawNoData(ctx, rect) {
  ctx.fillStyle = cssVar("--muted", "#a8b0bf");
  ctx.font = "13px Segoe UI";
  ctx.textAlign = "center";
  ctx.fillText(currentLanguage() === "en" ? "No data" : "暂无数据", rect.width / 2, rect.height / 2);
  ctx.textAlign = "left";
}

function cssVar(name, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function chartBg() {
  return currentTheme() === "light" ? "rgba(18, 26, 38, 0.06)" : "rgba(255,255,255,.08)";
}

function sortOption(value, label) {
  return `<option value="${value}" ${state.sort === value ? "selected" : ""}>${escapeHTML(label)}</option>`;
}

function roleOption(value, current) {
  const labels = {
    user: currentLanguage() === "en" ? "User" : "普通用户",
    viewer: currentLanguage() === "en" ? "Viewer" : "只读观察员",
    admin: currentLanguage() === "en" ? "Admin" : "管理员",
  };
  return `<option value="${value}" ${current === value ? "selected" : ""}>${labels[value]}</option>`;
}

function roleBadge(role) {
  return `<span class="role role-${escapeHTML(role)}">${escapeHTML(role)}</span>`;
}

function themeOptionsFor(current) {
  return [
    ["tech-dark", "Tech Dark"],
    ["graphite", "Graphite"],
    ["light", "Light"],
    ["aurora", "Aurora"],
    ["high-contrast", "High Contrast"],
  ].map(([value, label]) => `<option value="${value}" ${current === value ? "selected" : ""}>${label}</option>`).join("");
}

function languageOptionsFor(current) {
  return [
    ["auto", "Auto"],
    ["zh", "中文"],
    ["en", "English"],
  ].map(([value, label]) => `<option value="${value}" ${current === value ? "selected" : ""}>${label}</option>`).join("");
}

function densityOptions(current) {
  return [
    ["compact", currentLanguage() === "en" ? "Compact" : "紧凑"],
    ["comfortable", currentLanguage() === "en" ? "Comfortable" : "舒适"],
    ["spacious", currentLanguage() === "en" ? "Spacious" : "宽松"],
  ].map(([value, label]) => `<option value="${value}" ${current === value ? "selected" : ""}>${label}</option>`).join("");
}

function checkboxField(name, checked, label) {
  return `<label class="check-row"><input name="${name}" type="checkbox" ${checked ? "checked" : ""} /><span>${escapeHTML(label)}</span></label>`;
}

function progressBar(ratio) {
  const value = Math.max(0, Math.min(1, Number(ratio || 0)));
  return `<div class="progress"><i style="width:${Math.round(value * 100)}%"></i><span>${Math.round(value * 100)}%</span></div>`;
}

function statusBar(label, percentValue) {
  const value = Math.max(0, Math.min(100, Number(percentValue || 0)));
  return `<div class="status-bar"><div><strong>${escapeHTML(label)}</strong><span>${value.toFixed(1)}%</span></div><div class="progress"><i style="width:${value}%"></i></div></div>`;
}

function formatNumber(value) {
  return new Intl.NumberFormat(currentLanguage() === "en" ? "en-US" : "zh-CN").format(Number(value || 0));
}

function compactNumber(value) {
  return new Intl.NumberFormat(currentLanguage() === "en" ? "en-US" : "zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value || 0));
}

function formatDate(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString(currentLanguage() === "en" ? "en-US" : "zh-CN", { hour12: false });
}

function currencyAmount(value, currency) {
  try {
    return new Intl.NumberFormat(currentLanguage() === "en" ? "en-US" : "zh-CN", { style: "currency", currency: currency || "USD", maximumFractionDigits: 4 }).format(Number(value || 0));
  } catch {
    return `${Number(value || 0).toFixed(4)} ${currency || "USD"}`;
  }
}

function renderShellV2() {
  const appName = appearance().appName || "CPAMC Sidecar";
  const logoText = appearance().logoText || "C";
  app.innerHTML = `
    <div class="layout ${state.fullscreen ? "fullscreen-mode" : ""}">
      <aside class="sidebar">
        <div class="brand"><div class="mark">${escapeHTML(logoText)}</div><span>${escapeHTML(appName)}</span></div>
        <nav class="nav">
          ${navButton("dashboard", t("dashboard"))}
          ${navButton("models", t("models"))}
          ${canAdminViewer() ? navButton("insights", t("insights")) : ""}
          ${canAdmin() ? navButton("users", t("users")) : ""}
          ${canAdmin() ? navButton("alerts", t("alerts")) : ""}
          ${canAdmin() ? navButton("backups", t("backups")) : ""}
          ${canAdmin() ? navButton("snapshots", t("snapshots")) : ""}
          ${canAdminViewer() ? navButton("sessions", t("sessions")) : ""}
          ${canAdmin() ? navButton("health", t("health")) : ""}
          ${canAdmin() ? navButton("audit", t("audit")) : ""}
          ${canAdmin() ? navButton("settings", t("settings")) : ""}
          ${navButton("profile", t("profile"))}
        </nav>
      </aside>
      <section class="main">
        <header class="topbar topbar-v3">
          <div class="page-title">
            <h1>${titleForViewV2()}</h1>
            <p class="muted">${subtitleForView()}</p>
          </div>
          <div class="shell-actions">
            <div class="user-chip"><span>${escapeHTML(state.user.displayName)}</span><span class="role">${state.user.role}</span><span>${escapeHTML(state.user.apiKeyPreview)}</span></div>
            <div class="shell-selects">
              <select id="themeSelect" title="Theme">${themeOptions()}</select>
              <select id="languageSelect" title="Language">${languageOptions()}</select>
            </div>
            <div class="shell-buttons">
              <button id="fullscreenBtn">${state.fullscreen ? t("exitScreen") : t("bigScreen")}</button>
              <button id="refreshBtn">${t("refresh")}</button>
              <button id="logoutBtn">${t("logout")}</button>
            </div>
          </div>
        </header>
        ${state.error ? `<div class="error">${escapeHTML(state.error)}</div>` : ""}
        ${state.loading ? `<div class="empty">${t("loading")}</div>` : renderView()}
      </section>
      ${state.drawer ? renderDrawer() : ""}
    </div>
  `;
  bindShellEvents();
}

function renderUsers() {
  if (!canAdmin()) return `<div class="empty">${currentLanguage() === "en" ? "Admin only." : "仅管理员可访问。"}</div>`;
  return `
    <div class="users-layout">
      <section class="section users-panel">
        <div class="section-head">
          <h2>${currentLanguage() === "en" ? "Users" : "用户列表"}</h2>
          <span class="muted">${state.users.length} ${currentLanguage() === "en" ? "users" : "人"}</span>
        </div>
        ${state.users.length ? renderUserAdminRows() : `<div class="empty">${currentLanguage() === "en" ? "No local users yet." : "暂无用户。"}</div>`}
      </section>
      <section class="section user-create-panel">
        <div class="section-head"><h2>${currentLanguage() === "en" ? "Add Or Update User" : "添加或更新用户"}</h2></div>
        <form class="form-grid" id="addUserForm">
          <label><span class="muted">${currentLanguage() === "en" ? "Display name" : "显示名称"}</span><input name="displayName" placeholder="${currentLanguage() === "en" ? "For example Alice" : "例如 张三"}" /></label>
          <label><span class="muted">${currentLanguage() === "en" ? "Group" : "分组"}</span><input name="group" placeholder="${currentLanguage() === "en" ? "Production / Client A" : "例如 正式组 / 客户 A"}" /></label>
          <label><span class="muted">${currentLanguage() === "en" ? "Note" : "备注"}</span><input name="note" placeholder="${currentLanguage() === "en" ? "Owner or purpose" : "负责人或用途"}" /></label>
          <label><span class="muted">API Key</span><input name="apiKey" type="password" placeholder="sk-..." /></label>
          <label><span class="muted">${currentLanguage() === "en" ? "Role" : "角色"}</span><select name="role"><option value="user">${currentLanguage() === "en" ? "User" : "普通用户"}</option><option value="viewer">${currentLanguage() === "en" ? "Viewer" : "只读观察员"}</option><option value="admin">${currentLanguage() === "en" ? "Admin" : "管理员"}</option></select></label>
          <button class="primary" type="submit">${currentLanguage() === "en" ? "Save User" : "保存用户"}</button>
        </form>
        <div class="divider"></div>
        <div class="section-head"><h2>${currentLanguage() === "en" ? "Bind Extra Key" : "绑定附加 Key"}</h2></div>
        <form class="form-grid" id="addUserKeyForm">
          <label><span class="muted">${currentLanguage() === "en" ? "User" : "选择用户"}</span><select name="userId">${state.users.map((user) => `<option value="${user.id}">${escapeHTML(user.displayName)}</option>`).join("")}</select></label>
          <label><span class="muted">${currentLanguage() === "en" ? "Label" : "Key 标签"}</span><input name="label" placeholder="${currentLanguage() === "en" ? "Codex backup" : "例如 Codex 备用"}" /></label>
          <label><span class="muted">API Key</span><input name="apiKey" type="password" placeholder="sk-..." /></label>
          <button class="primary" type="submit">${currentLanguage() === "en" ? "Bind Key" : "绑定 Key"}</button>
        </form>
      </section>
    </div>
  `;
}

function renderUserAdminRows() {
  const labels = {
    name: currentLanguage() === "en" ? "Name" : "名称",
    group: currentLanguage() === "en" ? "Group" : "分组",
    note: currentLanguage() === "en" ? "Note" : "备注",
    role: currentLanguage() === "en" ? "Role" : "角色",
    key: "Key",
    limits: currentLanguage() === "en" ? "Limits" : "限额",
    status: currentLanguage() === "en" ? "Status" : "状态",
    actions: currentLanguage() === "en" ? "Actions" : "操作",
  };
  return `
    <div class="user-admin-table">
      <div class="user-admin-head">
        <span>${labels.name}</span><span>${labels.group}</span><span>${labels.note}</span><span>${labels.role}</span><span>${labels.key}</span><span>${labels.limits}</span><span>${labels.status}</span><span>${labels.actions}</span>
      </div>
      ${state.users.map((user) => `
        <article class="user-admin-row">
          <label class="user-field"><span>${labels.name}</span><input data-user-name="${user.id}" value="${escapeHTML(user.displayName)}" /></label>
          <label class="user-field"><span>${labels.group}</span><input data-user-group="${user.id}" value="${escapeHTML(user.group || "")}" placeholder="${currentLanguage() === "en" ? "Team / client" : "例如 测试组"}" /></label>
          <label class="user-field"><span>${labels.note}</span><input data-user-note="${user.id}" value="${escapeHTML(user.note || "")}" placeholder="${currentLanguage() === "en" ? "Owner or purpose" : "负责人或用途"}" /></label>
          <label class="user-field"><span>${labels.role}</span><select data-user-role="${user.id}">${roleOption("user", user.role)}${roleOption("viewer", user.role)}${roleOption("admin", user.role)}</select></label>
          <div class="user-key-cell"><span class="mobile-label">${labels.key}</span>${renderUserKeys(user)}</div>
          <div class="user-limit-cell"><span class="mobile-label">${labels.limits}</span>${renderLimitInputs(user)}</div>
          <div class="user-status-cell"><span class="mobile-label">${labels.status}</span>${user.disabled ? `<span class="warn">${currentLanguage() === "en" ? "Disabled" : "禁用"}</span>` : `<span class="ok">${currentLanguage() === "en" ? "Enabled" : "启用"}</span>`}</div>
          <div class="user-actions-cell">
            <span class="mobile-label">${labels.actions}</span>
            <button data-save-user="${user.id}">${currentLanguage() === "en" ? "Save" : "保存"}</button>
            <button data-toggle-user="${user.id}">${user.disabled ? (currentLanguage() === "en" ? "Enable" : "启用") : (currentLanguage() === "en" ? "Disable" : "禁用")}</button>
            <button class="danger" data-delete-user="${user.id}">${currentLanguage() === "en" ? "Delete" : "删除"}</button>
          </div>
        </article>
      `).join("")}
    </div>
  `;
}

function renderUserKeys(user) {
  const keys = user.apiKeys || [];
  if (!keys.length) return `<span class="muted">${escapeHTML(user.apiKeyPreview || "--")}</span>`;
  return `<div class="key-list">${keys.map((key) => `<span class="key-pill"><b>${escapeHTML(key.preview)}</b>${key.label ? `<small>${escapeHTML(key.label)}</small>` : ""}<button title="${currentLanguage() === "en" ? "Unbind" : "解绑"}" data-delete-user-key="${user.id}:${key.id}">x</button></span>`).join("")}</div>`;
}

function renderLimitInputs(user) {
  const limits = user.limits || {};
  return `
    <div class="limit-grid">
      <input data-limit="${user.id}:dailyTokens" value="${limits.dailyTokens || ""}" placeholder="${currentLanguage() === "en" ? "Daily tokens" : "日 Token"}" />
      <input data-limit="${user.id}:monthlyTokens" value="${limits.monthlyTokens || ""}" placeholder="${currentLanguage() === "en" ? "30d tokens" : "30 天 Token"}" />
      <input data-limit="${user.id}:dailyRequests" value="${limits.dailyRequests || ""}" placeholder="${currentLanguage() === "en" ? "Daily req" : "日请求"}" />
      <input data-limit="${user.id}:monthlyRequests" value="${limits.monthlyRequests || ""}" placeholder="${currentLanguage() === "en" ? "30d req" : "30 天请求"}" />
    </div>
  `;
}

function renderProfile() {
  return `
    <div class="profile-layout">
      <section class="section profile-panel">
        <div class="section-head"><h2>${currentLanguage() === "en" ? "Profile" : "个人资料"}</h2></div>
        <form class="form-grid" id="profileForm">
          <label><span class="muted">${currentLanguage() === "en" ? "Display name" : "显示名称"}</span><input name="displayName" value="${escapeHTML(state.user.displayName)}" /></label>
          <label><span class="muted">${currentLanguage() === "en" ? "Note" : "备注"}</span><input name="note" value="${escapeHTML(state.user.note || "")}" placeholder="${currentLanguage() === "en" ? "Purpose or owner" : "用途或负责人"}" /></label>
          <label><span class="muted">API Key</span><input value="${escapeHTML(state.user.apiKeyPreview)}" disabled /></label>
          <label><span class="muted">${currentLanguage() === "en" ? "Role" : "角色"}</span><input value="${escapeHTML(state.user.role)}" disabled /></label>
          <button class="primary" type="submit">${currentLanguage() === "en" ? "Save Profile" : "保存资料"}</button>
        </form>
      </section>
      <section class="section profile-summary">
        <div class="section-head"><h2>${currentLanguage() === "en" ? "Current Access" : "当前权限"}</h2></div>
        ${table([currentLanguage() === "en" ? "Item" : "项目", currentLanguage() === "en" ? "Value" : "值"], [
          [currentLanguage() === "en" ? "User" : "用户", escapeHTML(state.user.displayName)],
          [currentLanguage() === "en" ? "Role" : "角色", roleBadge(state.user.role)],
          ["API Key", escapeHTML(state.user.apiKeyPreview)],
          [currentLanguage() === "en" ? "Group" : "分组", escapeHTML(state.user.group || "--")],
        ])}
      </section>
    </div>
  `;
}

function localText(en, zh) {
  return currentLanguage() === "en" ? en : zh;
}

function themeChoiceLabel(value) {
  const labels = {
    "tech-dark": localText("Tech Dark", "科技深色"),
    graphite: localText("Graphite", "石墨深色"),
    light: localText("Light", "明亮浅色"),
    aurora: localText("Aurora", "极光主题"),
    "high-contrast": localText("High Contrast", "高对比度"),
  };
  return labels[value] || value;
}

function languageChoiceLabel(value) {
  const labels = {
    auto: localText("Auto", "跟随系统"),
    zh: localText("Chinese", "中文"),
    en: localText("English", "English"),
  };
  return labels[value] || value;
}

function themeOptions() {
  return ["tech-dark", "graphite", "light", "aurora", "high-contrast"]
    .map((value) => `<option value="${value}" ${currentTheme() === value ? "selected" : ""}>${escapeHTML(themeChoiceLabel(value))}</option>`)
    .join("");
}

function themeOptionsFor(current) {
  return ["tech-dark", "graphite", "light", "aurora", "high-contrast"]
    .map((value) => `<option value="${value}" ${current === value ? "selected" : ""}>${escapeHTML(themeChoiceLabel(value))}</option>`)
    .join("");
}

function languageOptions() {
  const selected = state.language || "auto";
  return ["auto", "zh", "en"]
    .map((value) => `<option value="${value}" ${selected === value ? "selected" : ""}>${escapeHTML(languageChoiceLabel(value))}</option>`)
    .join("");
}

function languageOptionsFor(current) {
  return ["auto", "zh", "en"]
    .map((value) => `<option value="${value}" ${current === value ? "selected" : ""}>${escapeHTML(languageChoiceLabel(value))}</option>`)
    .join("");
}

function navButton(view, label) {
  const safeLabel = escapeHTML(label);
  return `<button data-view="${view}" data-label="${safeLabel}" title="${safeLabel}" class="${state.view === view ? "active" : ""}">${safeLabel}</button>`;
}

function renderSettings() {
  if (!canAdmin()) return `<div class="empty">${localText("Settings are admin only.", "设置仅管理员可编辑。")}</div>`;
  const settings = effectiveSettings();
  const a = settings.appearance || {};
  const notifications = settings.notifications || {};
  const permissions = settings.permissions || {};
  const automation = settings.automation || {};
  const pricing = settings.pricing || {};
  const themeTitle = localText("Brand And Theme", "品牌与主题");
  const notifyTitle = localText("Notifications And Automation", "通知与自动化");
  const permissionTitle = localText("Permissions", "权限策略");
  const pricingTitle = localText("Model Pricing", "模型价格");
  return `
    <form id="settingsForm" class="settings-layout-v4">
      <div class="settings-grid-v4">
        <section class="section settings-card-v4">
          <div class="section-head"><h2>${themeTitle}</h2></div>
          <div class="form-grid settings-form-grid-v4">
            <label><span>${localText("App name", "应用名称")}</span><input name="appName" value="${escapeHTML(a.appName || "")}" /></label>
            <label><span>${localText("Logo text", "Logo 文案")}</span><input name="logoText" maxlength="4" value="${escapeHTML(a.logoText || "")}" /></label>
            <label><span>${localText("Default theme", "默认主题")}</span><select name="defaultTheme">${themeOptionsFor(a.defaultTheme || "tech-dark")}</select></label>
            <label><span>${localText("Default language", "默认语言")}</span><select name="defaultLanguage">${languageOptionsFor(a.defaultLanguage || "auto")}</select></label>
            <label><span>${localText("Density", "密度")}</span><select name="density">${densityOptions(a.density || "comfortable")}</select></label>
            <label><span>${localText("Radius", "圆角")}</span><input name="radius" type="number" min="4" max="18" value="${escapeHTML(a.radius || 8)}" /></label>
            <label><span>${localText("Primary color", "主色")}</span><input name="primary" type="color" value="${escapeHTML((a.customTheme || {}).primary || "#20c788")}" /></label>
            <label><span>${localText("Accent color", "强调色")}</span><input name="accent" type="color" value="${escapeHTML((a.customTheme || {}).accent || "#5fa8ff")}" /></label>
          </div>
        </section>

        <section class="section settings-card-v4">
          <div class="section-head"><h2>${notifyTitle}</h2><button type="button" id="testWebhookBtn">${localText("Test", "测试通知")}</button></div>
          <div class="form-grid">
            ${checkboxField("webhookEnabled", notifications.webhookEnabled, localText("Enable webhook", "启用 Webhook"))}
            <label><span>Webhook URL</span><input name="webhookUrl" value="${escapeHTML(notifications.webhookUrl || "")}" placeholder="https://..." /></label>
            ${checkboxField("dailyReportEnabled", notifications.dailyReportEnabled, localText("Daily report notification", "开启日报通知"))}
            <label><span>${localText("Daily report hour", "日报发送小时")}</span><input name="dailyReportHour" type="number" min="0" max="23" value="${escapeHTML(notifications.dailyReportHour ?? 9)}" /></label>
            ${checkboxField("anomalyEnabled", notifications.anomalyEnabled, localText("Anomaly notification", "开启异常通知"))}
            ${checkboxField("autoDisableOnLimitExceeded", automation.autoDisableOnLimitExceeded, localText("Auto-disable users after limits are exceeded", "超限后自动禁用普通用户"))}
          </div>
        </section>
      </div>

      <section class="section settings-policy-v4">
        <div class="section-head"><h2>${permissionTitle}</h2></div>
        <div class="settings-policy-row-v4">
          ${checkboxField("allowViewerExport", permissions.allowViewerExport, localText("Viewer can export usage", "只读观察员允许导出用量"))}
          <p class="muted">${localText("Roles: admin can edit everything, viewer can see global dashboards, user only sees own key.", "角色说明：admin 可编辑全部，viewer 只能看全局数据，user 只能看自己的 Key。")}</p>
        </div>
      </section>

      <section class="section settings-pricing-v4">
        <div class="section-head">
          <h2>${pricingTitle}</h2>
          <span class="muted">${localText("Prices are per million tokens.", "价格单位为每百万 Token。")}</span>
        </div>
        <div class="settings-pricing-grid-v4">
          <label class="pricing-currency-v4"><span>${localText("Currency", "货币")}</span><input name="currency" value="${escapeHTML(pricing.currency || "USD")}" /></label>
          <label class="pricing-json-v4"><span>${localText("Model prices JSON", "模型价格 JSON")}</span><textarea name="pricingModels" rows="14" spellcheck="false">${escapeHTML(JSON.stringify(pricing.models || {}, null, 2))}</textarea></label>
        </div>
        <p class="muted pricing-help-v4">${localText("Format: model -> inputPerMTok / outputPerMTok / cachedPerMTok / reasoningPerMTok.", "格式：模型名 -> inputPerMTok / outputPerMTok / cachedPerMTok / reasoningPerMTok。")}</p>
      </section>

      <section class="section settings-savebar settings-savebar-v4">
        <button class="primary" type="submit">${localText("Save Settings", "保存设置")}</button>
      </section>
    </form>
  `;
}

function renderUserAdminRows() {
  const labels = {
    name: localText("Name", "名称"),
    group: localText("Group", "分组"),
    note: localText("Note", "备注"),
    role: localText("Role", "角色"),
    key: "Key",
    limits: localText("Limits", "限额"),
    status: localText("Status", "状态"),
    actions: localText("Actions", "操作"),
  };
  return `
    <div class="user-admin-table user-admin-table-v4">
      <div class="user-admin-head">
        <span>${labels.name}</span><span>${labels.group}</span><span>${labels.note}</span><span>${labels.role}</span><span>${labels.key}</span><span>${labels.limits}</span><span>${labels.status}</span><span>${labels.actions}</span>
      </div>
      ${state.users.map((user) => {
        const statusClass = user.disabled ? "disabled" : "enabled";
        const statusText = user.disabled ? localText("Disabled", "禁用") : localText("Enabled", "启用");
        const toggleText = user.disabled ? localText("Enable", "启用") : localText("Disable", "禁用");
        return `
          <article class="user-admin-row">
            <label class="user-field"><span>${labels.name}</span><input data-user-name="${user.id}" value="${escapeHTML(user.displayName)}" /></label>
            <label class="user-field"><span>${labels.group}</span><input data-user-group="${user.id}" value="${escapeHTML(user.group || "")}" placeholder="${localText("Team / client", "例如 测试组")}" /></label>
            <label class="user-field"><span>${labels.note}</span><input data-user-note="${user.id}" value="${escapeHTML(user.note || "")}" placeholder="${localText("Owner or purpose", "负责人或用途")}" /></label>
            <label class="user-field"><span>${labels.role}</span><select data-user-role="${user.id}">${roleOption("user", user.role)}${roleOption("viewer", user.role)}${roleOption("admin", user.role)}</select></label>
            <div class="user-key-cell"><span class="mobile-label">${labels.key}</span>${renderUserKeys(user)}</div>
            <div class="user-limit-cell"><span class="mobile-label">${labels.limits}</span>${renderLimitInputs(user)}</div>
            <div class="user-status-cell"><span class="mobile-label">${labels.status}</span><span class="status-pill-v4 ${statusClass}">${statusText}</span></div>
            <div class="user-actions-cell">
              <span class="mobile-label">${labels.actions}</span>
              <button data-save-user="${user.id}">${localText("Save", "保存")}</button>
              <button data-toggle-user="${user.id}">${toggleText}</button>
              <button class="danger" data-delete-user="${user.id}">${localText("Delete", "删除")}</button>
            </div>
          </article>
        `;
      }).join("")}
    </div>
  `;
}
