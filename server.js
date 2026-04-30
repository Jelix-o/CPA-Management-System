const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { execFile } = require("child_process");

loadEnv();

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.resolve(process.env.APP_DATA_DIR || path.join(ROOT, "data"));
const USERS_FILE = path.join(DATA_DIR, "users.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const AUDIT_FILE = path.join(DATA_DIR, "audit.log");
const SNAPSHOT_DIR = path.join(DATA_DIR, "usage-snapshots");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const AUTOMATION_STATE_FILE = path.join(DATA_DIR, "automation-state.json");

const CONFIG = {
  host: process.env.APP_HOST || "0.0.0.0",
  port: Number(process.env.APP_PORT || 8787),
  sessionSecret: process.env.APP_SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
  cpamcBaseUrl: trimTrailingSlash(process.env.CPAMC_BASE_URL || "http://127.0.0.1:8317"),
  cpamcManagementKey: process.env.CPAMC_MANAGEMENT_KEY || "",
  adminApiKeys: splitCSV(process.env.ADMIN_API_KEYS || ""),
  autoCreateUsers: parseBool(process.env.AUTO_CREATE_USERS, true),
  validateLogin: parseBool(process.env.CPAMC_VALIDATE_LOGIN, true),
  autoBackupEnabled: parseBool(process.env.AUTO_BACKUP_ENABLED, true),
  autoBackupRetention: Number(process.env.AUTO_BACKUP_RETENTION || 14),
  usageSnapshotEnabled: parseBool(process.env.USAGE_SNAPSHOT_ENABLED, true),
  usageSnapshotIntervalMinutes: Number(process.env.USAGE_SNAPSHOT_INTERVAL_MINUTES || 60),
  usageSnapshotRetention: Number(process.env.USAGE_SNAPSHOT_RETENTION || 72),
};

const sessions = new Map();
const loginAttempts = new Map();
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

ensureDataFiles();
scheduleAutoBackup();
scheduleUsageSnapshot();
scheduleDailyReport();

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (err) {
    console.error(err);
    sendJSON(res, 500, { error: "internal_server_error", message: err.message });
  }
});

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`CPAMC sidecar manager listening on http://${CONFIG.host}:${CONFIG.port}`);
  console.log(`CPAMC upstream: ${CONFIG.cpamcBaseUrl}`);
});

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname.startsWith("/api/")) {
    await handleAPI(req, res, url);
    return;
  }

  await serveStatic(req, res, url.pathname);
}

async function handleAPI(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJSON(res, 200, {
      ok: true,
      cpamcBaseUrl: CONFIG.cpamcBaseUrl,
      managementConfigured: CONFIG.cpamcManagementKey.length > 0,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readJSON(req);
    const apiKey = String(body.apiKey || "").trim();
    const clientIP = getClientIP(req);
    if (!apiKey) {
      sendJSON(res, 400, { error: "missing_api_key" });
      return;
    }
    const loginGuard = checkLoginRateLimit(clientIP);
    if (!loginGuard.ok) {
      sendJSON(res, 429, { error: "too_many_login_attempts", retry_after_seconds: loginGuard.retryAfterSeconds });
      return;
    }

    if (CONFIG.validateLogin) {
      const valid = await validateCPAMCAPIKey(apiKey);
      if (!valid.ok) {
        recordLoginFailure(clientIP);
        writeAudit("login_failed", null, {
          apiKeyPreview: maskAPIKey(apiKey),
          reason: valid.message || "CPAMC rejected this API key.",
        });
        sendJSON(res, 401, {
          error: "invalid_api_key",
          message: valid.message || "CPAMC rejected this API key.",
        });
        return;
      }
    }

    const apiKeyHash = hashAPIKey(apiKey);
    let store = readUsers();
    let user = findUserByAPIKeyHash(store.users, apiKeyHash);
    const envAdmin = CONFIG.adminApiKeys.some((key) => hashAPIKey(key) === apiKeyHash);

    if (!user) {
      if (!CONFIG.autoCreateUsers && !envAdmin) {
        sendJSON(res, 403, { error: "user_not_configured" });
        return;
      }
      user = {
        id: crypto.randomUUID(),
        displayName: envAdmin ? "Administrator" : `User ${maskAPIKey(apiKey)}`,
        role: envAdmin ? "admin" : "user",
        apiKeyHash,
        apiKeyPreview: maskAPIKey(apiKey),
        apiKeys: [makeAPIKeyRecord(apiKey, "主 Key")],
        group: "",
        limits: defaultLimits(),
        disabled: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      store.users.push(user);
      writeUsers(store);
    } else {
      let changed = ensureUserHasAPIKey(user, apiKey, "登录 Key");
      if (envAdmin && user.role !== "admin") {
        user.role = "admin";
        changed = true;
      }
      if (changed) {
        user.updatedAt = new Date().toISOString();
        writeUsers(store);
      }
    }

    if (user.disabled) {
      writeAudit("login_blocked", null, { user: publicUser(user) });
      sendJSON(res, 403, { error: "user_disabled" });
      return;
    }

    const token = createSession(user, apiKey);
    resetLoginFailures(clientIP);
    writeAudit("login", { user }, { user: publicUser(user) });
    sendJSON(res, 200, { token, user: publicUser(user), settings: publicSettings(readSettings(), user) });
    return;
  }

  const session = requireSession(req, res);
  if (!session) return;

  if (req.method === "POST" && url.pathname === "/api/logout") {
    sessions.delete(session.token);
    writeAudit("logout", session, {});
    sendJSON(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/me") {
    sendJSON(res, 200, { user: publicUser(session.user), settings: publicSettings(readSettings(), session.user) });
    return;
  }

  if (req.method === "PATCH" && url.pathname === "/api/me") {
    const body = await readJSON(req);
    const store = readUsers();
    const user = store.users.find((item) => item.id === session.user.id);
    if (!user) {
      sendJSON(res, 404, { error: "user_not_found" });
      return;
    }
    if (body.displayName !== undefined) {
      user.displayName = String(body.displayName || "").trim() || user.displayName;
    }
    if (body.note !== undefined) {
      user.note = String(body.note || "").trim();
    }
    user.updatedAt = new Date().toISOString();
    writeUsers(store);
    session.user = user;
    writeAudit("profile_update", session, { user: publicUser(user) });
    sendJSON(res, 200, { user: publicUser(user) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/models") {
    const models = await cpamcFetchJSON("/v1/models", { apiKey: session.apiKey });
    sendJSON(res, 200, models);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/usage") {
    const upstream = await cpamcManagementFetchJSON("/v0/management/usage");
    const snapshot = upstream.usage || {};
    const range = parseTimeRange(url.searchParams);
    const scoped = session.user.role === "admin" || session.user.role === "viewer"
      ? snapshot
      : filterUsageForSession(snapshot, session);
    const usage = range.hasRange ? filterUsageByTime(scoped, range) : normaliseSnapshot(scoped);
    sendJSON(res, 200, {
      usage,
      failed_requests: usage.failure_count || 0,
      scope: session.user.role === "admin" || session.user.role === "viewer" ? "all" : "own",
      range: publicRange(range),
      api_aliases: buildAPIAliases(usage.apis || {}),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/usage/export") {
    const upstream = await cpamcManagementFetchJSON("/v0/management/usage");
    const snapshot = upstream.usage || {};
    const range = parseTimeRange(url.searchParams);
    const settings = readSettings();
    if (session.user.role === "viewer" && !(settings.permissions || {}).allowViewerExport) {
      sendJSON(res, 403, { error: "viewer_export_disabled" });
      return;
    }
    const scoped = session.user.role === "admin" || session.user.role === "viewer"
      ? snapshot
      : filterUsageForSession(snapshot, session);
    const usage = range.hasRange ? filterUsageByTime(scoped, range) : normaliseSnapshot(scoped);
    const format = String(url.searchParams.get("format") || "json").toLowerCase();
    writeAudit("usage_export", session, { format, range: publicRange(range) });
    if (format === "csv") {
      sendDownloadText(res, `cpamc-usage-${Date.now()}.csv`, usageToCSV(usage), "text/csv; charset=utf-8");
      return;
    }
    sendDownloadJSON(res, `cpamc-usage-${Date.now()}.json`, {
      version: 1,
      exportedAt: new Date().toISOString(),
      scope: session.user.role === "admin" || session.user.role === "viewer" ? "all" : "own",
      range: publicRange(range),
      usage,
    });
    return;
  }

  if (url.pathname === "/api/users") {
    if (!requireAdmin(session, res)) return;

    if (req.method === "GET") {
      sendJSON(res, 200, { users: readUsers().users.map(publicUser) });
      return;
    }

    if (req.method === "POST") {
      const body = await readJSON(req);
      const apiKey = String(body.apiKey || "").trim();
      const role = normaliseRole(body.role);
      const displayName = String(body.displayName || "").trim();
      const note = String(body.note || "").trim();
      const group = String(body.group || "").trim();
      const limits = normaliseLimits(body.limits || {});
      if (!apiKey) {
        sendJSON(res, 400, { error: "missing_api_key" });
        return;
      }
      if (CONFIG.validateLogin) {
        const valid = await validateCPAMCAPIKey(apiKey);
        if (!valid.ok) {
          sendJSON(res, 400, { error: "invalid_api_key", message: valid.message });
          return;
        }
      }

      const apiKeyHash = hashAPIKey(apiKey);
      const store = readUsers();
      let user = store.users.find((item) => item.apiKeyHash === apiKeyHash);
      if (!user) {
        user = {
          id: crypto.randomUUID(),
          displayName: displayName || `User ${maskAPIKey(apiKey)}`,
          role,
          apiKeyHash,
          apiKeyPreview: maskAPIKey(apiKey),
          apiKeys: [makeAPIKeyRecord(apiKey, "主 Key")],
          note,
          group,
          limits,
          disabled: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        store.users.push(user);
      } else {
        user.displayName = displayName || user.displayName;
        user.note = note || user.note || "";
        user.group = group;
        user.limits = limits;
        ensureUserHasAPIKey(user, apiKey, "主 Key");
        user.role = role;
        user.disabled = false;
        user.updatedAt = new Date().toISOString();
      }
      writeUsers(store);
      writeAudit("user_save", session, { user: publicUser(user) });
      sendJSON(res, 200, { user: publicUser(user) });
      return;
    }
  }

  const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch) {
    if (!requireAdmin(session, res)) return;
    const userId = decodeURIComponent(userMatch[1]);
    const store = readUsers();
    const user = store.users.find((item) => item.id === userId);
    if (!user) {
      sendJSON(res, 404, { error: "user_not_found" });
      return;
    }

    if (req.method === "PATCH") {
      const body = await readJSON(req);
      if (body.displayName !== undefined) {
        user.displayName = String(body.displayName || "").trim() || user.displayName;
      }
      if (body.note !== undefined) {
        user.note = String(body.note || "").trim();
      }
      if (body.group !== undefined) {
        user.group = String(body.group || "").trim();
      }
      if (body.limits !== undefined) {
        user.limits = normaliseLimits(body.limits || {});
      }
      if (body.role !== undefined) {
        user.role = normaliseRole(body.role);
      }
      if (body.disabled !== undefined) {
        user.disabled = Boolean(body.disabled);
      }
      user.updatedAt = new Date().toISOString();
      writeUsers(store);
      writeAudit("user_update", session, { user: publicUser(user) });
      sendJSON(res, 200, { user: publicUser(user) });
      return;
    }

    if (req.method === "DELETE") {
      store.users = store.users.filter((item) => item.id !== userId);
      writeUsers(store);
      writeAudit("user_delete", session, { user: publicUser(user) });
      sendJSON(res, 200, { ok: true });
      return;
    }
  }

  const userAPIKeysMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/api-keys(?:\/([^/]+))?$/);
  if (userAPIKeysMatch) {
    if (!requireAdmin(session, res)) return;
    const userId = decodeURIComponent(userAPIKeysMatch[1]);
    const keyId = userAPIKeysMatch[2] ? decodeURIComponent(userAPIKeysMatch[2]) : "";
    const store = readUsers();
    const user = store.users.find((item) => item.id === userId);
    if (!user) {
      sendJSON(res, 404, { error: "user_not_found" });
      return;
    }

    if (req.method === "POST" && !keyId) {
      const body = await readJSON(req);
      const apiKey = String(body.apiKey || "").trim();
      const label = String(body.label || "").trim();
      if (!apiKey) {
        sendJSON(res, 400, { error: "missing_api_key" });
        return;
      }
      if (CONFIG.validateLogin) {
        const valid = await validateCPAMCAPIKey(apiKey);
        if (!valid.ok) {
          sendJSON(res, 400, { error: "invalid_api_key", message: valid.message });
          return;
        }
      }
      const apiKeyHash = hashAPIKey(apiKey);
      const owner = findUserByAPIKeyHash(store.users, apiKeyHash);
      if (owner && owner.id !== user.id) {
        sendJSON(res, 409, { error: "api_key_already_bound", owner: publicUser(owner) });
        return;
      }
      ensureUserHasAPIKey(user, apiKey, label || "附加 Key");
      user.updatedAt = new Date().toISOString();
      writeUsers(store);
      writeAudit("user_api_key_add", session, { user: publicUser(user), apiKeyPreview: maskAPIKey(apiKey) });
      sendJSON(res, 200, { user: publicUser(user) });
      return;
    }

    if (req.method === "DELETE" && keyId) {
      user.apiKeys = (user.apiKeys || []).filter((item) => item.id !== keyId);
      const first = user.apiKeys[0];
      user.apiKeyHash = first ? first.hash : user.apiKeyHash;
      user.apiKeyPreview = first ? first.preview : user.apiKeyPreview;
      user.updatedAt = new Date().toISOString();
      writeUsers(store);
      writeAudit("user_api_key_delete", session, { user: publicUser(user), keyId });
      sendJSON(res, 200, { user: publicUser(user) });
      return;
    }
  }

  if (url.pathname === "/api/backups") {
    if (!requireAdmin(session, res)) return;

    if (req.method === "GET") {
      sendJSON(res, 200, { backups: listBackups() });
      return;
    }

    if (req.method === "POST") {
      const backup = buildBackupPayload();
      const fileName = `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      const filePath = path.join(BACKUP_DIR, fileName);
      fs.writeFileSync(filePath, JSON.stringify(backup, null, 2));
      writeAudit("backup_create", session, { fileName });
      sendJSON(res, 200, { backup: describeBackupFile(filePath) });
      return;
    }
  }

  if (req.method === "GET" && url.pathname === "/api/backups/export") {
    if (!requireAdmin(session, res)) return;
    writeAudit("backup_export", session, {});
    sendDownloadJSON(res, `cpamc-sidecar-backup-${Date.now()}.json`, buildBackupPayload());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/backups/import") {
    if (!requireAdmin(session, res)) return;
    const body = await readJSON(req);
    const backup = body.backup || body;
    const mode = String(body.mode || "merge").toLowerCase() === "replace" ? "replace" : "merge";
    const result = importBackup(backup, mode);
    writeAudit("backup_import", session, result);
    sendJSON(res, 200, result);
    return;
  }

  const backupMatch = url.pathname.match(/^\/api\/backups\/([^/]+)$/);
  if (backupMatch) {
    if (!requireAdmin(session, res)) return;
    const fileName = safeBackupFileName(decodeURIComponent(backupMatch[1]));
    if (!fileName) {
      sendJSON(res, 400, { error: "invalid_backup_file" });
      return;
    }
    const filePath = path.join(BACKUP_DIR, fileName);
    if (!fs.existsSync(filePath)) {
      sendJSON(res, 404, { error: "backup_not_found" });
      return;
    }
    if (req.method === "GET") {
      writeAudit("backup_download", session, { fileName });
      sendDownloadFile(res, fileName, filePath);
      return;
    }
    if (req.method === "DELETE") {
      fs.unlinkSync(filePath);
      writeAudit("backup_delete", session, { fileName });
      sendJSON(res, 200, { ok: true });
      return;
    }
  }

  if (req.method === "GET" && url.pathname === "/api/audit") {
    if (!requireAdmin(session, res)) return;
    const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 200), 1000));
    sendJSON(res, 200, { events: readAudit(limit) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/system/status") {
    if (!requireAdmin(session, res)) return;
    sendJSON(res, 200, await buildSystemStatus());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/alerts") {
    const upstream = await cpamcManagementFetchJSON("/v0/management/usage");
    const snapshot = upstream.usage || {};
    sendJSON(res, 200, buildAlertsPayload(snapshot, session));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/insights") {
    const upstream = await cpamcManagementFetchJSON("/v0/management/usage");
    const snapshot = upstream.usage || {};
    const range = parseTimeRange(url.searchParams);
    const scoped = session.user.role === "admin" || session.user.role === "viewer"
      ? snapshot
      : filterUsageForSession(snapshot, session);
    const usage = range.hasRange ? filterUsageByTime(scoped, range) : normaliseSnapshot(scoped);
    sendJSON(res, 200, buildInsightsPayload(usage, session));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/reports/daily") {
    const upstream = await cpamcManagementFetchJSON("/v0/management/usage");
    const snapshot = upstream.usage || {};
    const usage = filterUsageByTime(session.user.role === "admin" || session.user.role === "viewer" ? snapshot : filterUsageForSession(snapshot, session), presetToRange("today"));
    const report = buildDailyReport(usage, session);
    if (url.searchParams.get("notify") === "1") {
      await sendWebhook("daily_report", report);
      writeAudit("report_notify", session, { type: "daily" });
    }
    sendJSON(res, 200, report);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/groups") {
    if (!requireAdminViewer(session, res)) return;
    const upstream = await cpamcManagementFetchJSON("/v0/management/usage");
    const snapshot = upstream.usage || {};
    sendJSON(res, 200, { groups: buildGroupStats(snapshot) });
    return;
  }

  if (url.pathname === "/api/settings") {
    if (req.method === "GET") {
      sendJSON(res, 200, { settings: publicSettings(readSettings(), session.user) });
      return;
    }
    if (req.method === "PUT" || req.method === "PATCH") {
      if (!requireAdmin(session, res)) return;
      const body = await readJSON(req);
      const settings = mergeSettings(readSettings(), body.settings || body);
      writeSettings(settings);
      writeAudit("settings_update", session, { sections: Object.keys(body.settings || body || {}) });
      sendJSON(res, 200, { settings: publicSettings(settings, session.user) });
      return;
    }
  }

  if (req.method === "POST" && url.pathname === "/api/notifications/test") {
    if (!requireAdmin(session, res)) return;
    const result = await sendWebhook("test", {
      title: "CPAMC Sidecar test notification",
      at: new Date().toISOString(),
      actor: publicUser(session.user),
    });
    writeAudit("notification_test", session, result);
    sendJSON(res, 200, result);
    return;
  }

  if (url.pathname === "/api/sessions") {
    if (req.method === "GET") {
      if (!requireAdminViewer(session, res)) return;
      sendJSON(res, 200, { sessions: listSessions() });
      return;
    }
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch && req.method === "DELETE") {
    if (!requireAdmin(session, res)) return;
    const sessionId = decodeURIComponent(sessionMatch[1]);
    const revoked = revokeSession(sessionId);
    writeAudit("session_revoke", session, { sessionId, revoked });
    sendJSON(res, 200, { ok: true, revoked });
    return;
  }

  if (url.pathname === "/api/snapshots") {
    if (!requireAdmin(session, res)) return;
    if (req.method === "GET") {
      sendJSON(res, 200, { snapshots: listUsageSnapshots() });
      return;
    }
    if (req.method === "POST") {
      const snapshot = await createUsageSnapshot("manual");
      writeAudit("usage_snapshot_create", session, { fileName: snapshot.fileName });
      sendJSON(res, 200, { snapshot });
      return;
    }
  }

  const snapshotMatch = url.pathname.match(/^\/api\/snapshots\/([^/]+)$/);
  if (snapshotMatch) {
    if (!requireAdmin(session, res)) return;
    const fileName = safeSnapshotFileName(decodeURIComponent(snapshotMatch[1]));
    if (!fileName) {
      sendJSON(res, 400, { error: "invalid_snapshot_file" });
      return;
    }
    const filePath = path.join(SNAPSHOT_DIR, fileName);
    if (!fs.existsSync(filePath)) {
      sendJSON(res, 404, { error: "snapshot_not_found" });
      return;
    }
    if (req.method === "GET") {
      writeAudit("usage_snapshot_download", session, { fileName });
      sendDownloadFile(res, fileName, filePath);
      return;
    }
    if (req.method === "DELETE") {
      fs.unlinkSync(filePath);
      writeAudit("usage_snapshot_delete", session, { fileName });
      sendJSON(res, 200, { ok: true });
      return;
    }
  }

  sendJSON(res, 404, { error: "not_found" });
}

function createSession(user, apiKey) {
  const random = crypto.randomBytes(32).toString("hex");
  const signature = crypto
    .createHmac("sha256", CONFIG.sessionSecret)
    .update(`${user.id}:${random}`)
    .digest("hex");
  const token = `${random}.${signature}`;
  sessions.set(token, {
    id: hashAPIKey(token).slice(0, 16),
    token,
    user,
    apiKey,
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return token;
}

function requireSession(req, res) {
  const auth = req.headers.authorization || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const session = token ? sessions.get(token) : null;
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    sendJSON(res, 401, { error: "unauthorized" });
    return null;
  }

  const storeUser = readUsers().users.find((item) => item.id === session.user.id);
  if (!storeUser || storeUser.disabled) {
    sessions.delete(token);
    sendJSON(res, 401, { error: "user_disabled_or_removed" });
    return null;
  }
  session.user = storeUser;
  session.lastSeenAt = new Date().toISOString();
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function requireAdmin(session, res) {
  if (session.user.role !== "admin") {
    sendJSON(res, 403, { error: "admin_required" });
    return false;
  }
  return true;
}

function requireAdminViewer(session, res) {
  if (session.user.role !== "admin" && session.user.role !== "viewer") {
    sendJSON(res, 403, { error: "admin_or_viewer_required" });
    return false;
  }
  return true;
}

async function validateCPAMCAPIKey(apiKey) {
  try {
    const response = await cpamcFetch("/v1/models", { apiKey });
    if (response.ok) return { ok: true };
    const text = await response.text();
    return { ok: false, message: text.slice(0, 240) };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

async function cpamcManagementFetchJSON(route) {
  if (!CONFIG.cpamcManagementKey) {
    const err = new Error("CPAMC_MANAGEMENT_KEY is not configured.");
    err.statusCode = 500;
    throw err;
  }
  const response = await cpamcFetch(route, {
    managementKey: CONFIG.cpamcManagementKey,
  });
  return parseCPAMCResponse(response);
}

async function cpamcFetchJSON(route, options) {
  const response = await cpamcFetch(route, options);
  return parseCPAMCResponse(response);
}

async function cpamcFetch(route, options = {}) {
  const headers = { Accept: "application/json" };
  if (options.apiKey) {
    headers.Authorization = `Bearer ${options.apiKey}`;
  }
  if (options.managementKey) {
    headers.Authorization = `Bearer ${options.managementKey}`;
    headers["X-Management-Key"] = options.managementKey;
  }
  const target = `${CONFIG.cpamcBaseUrl}${route}`;
  if (typeof fetch === "function") {
    return fetch(target, {
      method: options.method || "GET",
      headers,
    });
  }
  return nodeFetch(target, {
    method: options.method || "GET",
    headers,
  });
}

function nodeFetch(target, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(
      url,
      {
        method: options.method || "GET",
        headers: options.headers || {},
        timeout: 15000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            text: async () => body,
          });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("CPAMC request timed out")));
    req.on("error", reject);
    req.end();
  });
}

async function parseCPAMCResponse(response) {
  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }
  if (!response.ok) {
    const err = new Error(payload.error || payload.message || `CPAMC returned ${response.status}`);
    err.statusCode = response.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

function filterUsageForAPIKey(snapshot, apiKey) {
  const apiKeyHash = hashAPIKey(apiKey);
  const preview = maskAPIKey(apiKey);
  const result = {
    total_requests: 0,
    success_count: 0,
    failure_count: 0,
    total_tokens: 0,
    apis: {},
    requests_by_day: {},
    requests_by_hour: {},
    tokens_by_day: {},
    tokens_by_hour: {},
  };
  const apis = snapshot.apis || {};
  for (const [statsKey, apiStats] of Object.entries(apis)) {
    const matches =
      statsKey === apiKey ||
      statsKey === preview ||
      hashAPIKey(statsKey) === apiKeyHash ||
      maskAPIKey(statsKey) === preview;
    if (!matches) continue;
    result.apis[statsKey] = apiStats;
    result.total_requests += Number(apiStats.total_requests || 0);
    result.total_tokens += Number(apiStats.total_tokens || 0);
    for (const modelStats of Object.values(apiStats.models || {})) {
      for (const detail of modelStats.details || []) {
        const failed = Boolean(detail.failed);
        if (failed) result.failure_count += 1;
        else result.success_count += 1;
        const timestamp = detail.timestamp ? new Date(detail.timestamp) : null;
        if (timestamp && !Number.isNaN(timestamp.getTime())) {
          const day = timestamp.toISOString().slice(0, 10);
          const hour = String(timestamp.getHours()).padStart(2, "0");
          const tokens = Number((detail.tokens || {}).total_tokens || 0);
          result.requests_by_day[day] = (result.requests_by_day[day] || 0) + 1;
          result.requests_by_hour[hour] = (result.requests_by_hour[hour] || 0) + 1;
          result.tokens_by_day[day] = (result.tokens_by_day[day] || 0) + tokens;
          result.tokens_by_hour[hour] = (result.tokens_by_hour[hour] || 0) + tokens;
        }
      }
    }
  }
  return result;
}

function filterUsageForSession(snapshot, session) {
  if (!session || !session.user) return emptyUsageSnapshot();
  const matchers = buildUserAPIKeyMatchers(session.user, session.apiKey);
  return filterUsageByMatchers(snapshot, matchers);
}

function filterUsageForUser(snapshot, user) {
  return filterUsageByMatchers(snapshot, buildUserAPIKeyMatchers(user, ""));
}

function filterUsageByMatchers(snapshot, matchers) {
  const result = emptyUsageSnapshot();
  const apis = (snapshot && snapshot.apis) || {};
  for (const [statsKey, apiStats] of Object.entries(apis)) {
    if (!matchesAnyAPIKey(statsKey, matchers)) continue;
    result.apis[statsKey] = apiStats;
    result.total_requests += Number(apiStats.total_requests || 0);
    result.total_tokens += Number(apiStats.total_tokens || 0);
    for (const modelStats of Object.values(apiStats.models || {})) {
      for (const detail of modelStats.details || []) {
        const failed = Boolean(detail.failed);
        if (failed) result.failure_count += 1;
        else result.success_count += 1;
        const timestamp = detail.timestamp ? new Date(detail.timestamp) : null;
        if (timestamp && !Number.isNaN(timestamp.getTime())) {
          const day = timestamp.toISOString().slice(0, 10);
          const hour = String(timestamp.getHours()).padStart(2, "0");
          const tokens = Number((detail.tokens || {}).total_tokens || 0);
          result.requests_by_day[day] = (result.requests_by_day[day] || 0) + 1;
          result.requests_by_hour[hour] = (result.requests_by_hour[hour] || 0) + 1;
          result.tokens_by_day[day] = (result.tokens_by_day[day] || 0) + tokens;
          result.tokens_by_hour[hour] = (result.tokens_by_hour[hour] || 0) + tokens;
        }
      }
    }
  }
  return result;
}

function buildUserAPIKeyMatchers(user, currentAPIKey) {
  const keys = [];
  if (currentAPIKey) keys.push(makeAPIKeyMatcher(currentAPIKey));
  for (const record of userAPIKeyRecords(user)) {
    keys.push({
      value: "",
      hash: record.hash || "",
      preview: record.preview || "",
    });
  }
  if (user && user.apiKeyHash) {
    keys.push({
      value: "",
      hash: user.apiKeyHash,
      preview: user.apiKeyPreview || "",
    });
  }
  const seen = new Set();
  return keys.filter((item) => {
    const key = `${item.value}|${item.hash}|${item.preview}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return item.value || item.hash || item.preview;
  });
}

function makeAPIKeyMatcher(apiKey) {
  return {
    value: apiKey,
    hash: hashAPIKey(apiKey),
    preview: maskAPIKey(apiKey),
  };
}

function matchesAnyAPIKey(statsKey, matchers) {
  const statsHash = hashAPIKey(statsKey);
  const statsPreview = maskAPIKey(statsKey);
  return matchers.some((matcher) =>
    (matcher.value && statsKey === matcher.value) ||
    (matcher.preview && statsKey === matcher.preview) ||
    (matcher.preview && statsPreview === matcher.preview) ||
    (matcher.hash && statsHash === matcher.hash)
  );
}

function normaliseSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return emptyUsageSnapshot();
  }
  return {
    total_requests: Number(snapshot.total_requests || 0),
    success_count: Number(snapshot.success_count || 0),
    failure_count: Number(snapshot.failure_count || 0),
    total_tokens: Number(snapshot.total_tokens || 0),
    apis: snapshot.apis || {},
    requests_by_day: snapshot.requests_by_day || {},
    requests_by_hour: snapshot.requests_by_hour || {},
    tokens_by_day: snapshot.tokens_by_day || {},
    tokens_by_hour: snapshot.tokens_by_hour || {},
  };
}

function emptyUsageSnapshot() {
  return {
    total_requests: 0,
    success_count: 0,
    failure_count: 0,
    total_tokens: 0,
    apis: {},
    requests_by_day: {},
    requests_by_hour: {},
    tokens_by_day: {},
    tokens_by_hour: {},
  };
}

function filterUsageByTime(snapshot, range) {
  const result = emptyUsageSnapshot();
  const apis = (snapshot && snapshot.apis) || {};
  for (const [apiName, apiStats] of Object.entries(apis)) {
    for (const [modelName, modelStats] of Object.entries((apiStats && apiStats.models) || {})) {
      for (const detail of (modelStats && modelStats.details) || []) {
        const ts = detail && detail.timestamp ? new Date(detail.timestamp).getTime() : NaN;
        if (Number.isNaN(ts)) continue;
        if (range.fromMs !== null && ts < range.fromMs) continue;
        if (range.toMs !== null && ts > range.toMs) continue;
        addUsageDetail(result, apiName, modelName, detail);
      }
    }
  }
  return result;
}

function addUsageDetail(snapshot, apiName, modelName, detail) {
  const tokens = normaliseDetailTokens((detail && detail.tokens) || {});
  const clonedDetail = {
    timestamp: detail.timestamp,
    latency_ms: Number(detail.latency_ms || 0),
    source: detail.source || "",
    auth_index: detail.auth_index || "",
    tokens,
    failed: Boolean(detail.failed),
  };
  const apiStats = snapshot.apis[apiName] || {
    total_requests: 0,
    total_tokens: 0,
    models: {},
  };
  const modelStats = apiStats.models[modelName] || {
    total_requests: 0,
    total_tokens: 0,
    details: [],
  };

  snapshot.total_requests += 1;
  if (clonedDetail.failed) snapshot.failure_count += 1;
  else snapshot.success_count += 1;
  snapshot.total_tokens += tokens.total_tokens;

  apiStats.total_requests += 1;
  apiStats.total_tokens += tokens.total_tokens;
  modelStats.total_requests += 1;
  modelStats.total_tokens += tokens.total_tokens;
  modelStats.details.push(clonedDetail);
  apiStats.models[modelName] = modelStats;
  snapshot.apis[apiName] = apiStats;

  const timestamp = new Date(clonedDetail.timestamp);
  const day = timestamp.toISOString().slice(0, 10);
  const hour = String(timestamp.getHours()).padStart(2, "0");
  snapshot.requests_by_day[day] = (snapshot.requests_by_day[day] || 0) + 1;
  snapshot.requests_by_hour[hour] = (snapshot.requests_by_hour[hour] || 0) + 1;
  snapshot.tokens_by_day[day] = (snapshot.tokens_by_day[day] || 0) + tokens.total_tokens;
  snapshot.tokens_by_hour[hour] = (snapshot.tokens_by_hour[hour] || 0) + tokens.total_tokens;
}

function normaliseDetailTokens(tokens) {
  const result = {
    input_tokens: Number(tokens.input_tokens || 0),
    output_tokens: Number(tokens.output_tokens || 0),
    reasoning_tokens: Number(tokens.reasoning_tokens || 0),
    cached_tokens: Number(tokens.cached_tokens || 0),
    total_tokens: Number(tokens.total_tokens || 0),
  };
  if (!result.total_tokens) {
    result.total_tokens = result.input_tokens + result.output_tokens + result.reasoning_tokens;
  }
  if (!result.total_tokens) {
    result.total_tokens += result.cached_tokens;
  }
  return result;
}

function parseTimeRange(searchParams) {
  const preset = String(searchParams.get("preset") || "").toLowerCase();
  const presetRange = presetToRange(preset);
  if (presetRange) return presetRange;

  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const fromMs = parseDateMs(from);
  const toMs = parseDateMs(to);
  return {
    from: fromMs === null ? null : new Date(fromMs).toISOString(),
    to: toMs === null ? null : new Date(toMs).toISOString(),
    fromMs,
    toMs,
    hasRange: fromMs !== null || toMs !== null,
    preset: "",
  };
}

function presetToRange(preset) {
  const now = new Date();
  const end = now.getTime();
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  let start = null;
  if (preset === "1h") start = end - hour;
  else if (preset === "24h") start = end - 24 * hour;
  else if (preset === "7d") start = end - 7 * day;
  else if (preset === "30d") start = end - 30 * day;
  else if (preset === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    start = d.getTime();
  } else if (preset === "yesterday") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    start = d.getTime() - day;
    return {
      from: new Date(start).toISOString(),
      to: new Date(d.getTime() - 1).toISOString(),
      fromMs: start,
      toMs: d.getTime() - 1,
      hasRange: true,
      preset,
    };
  } else {
    return null;
  }
  return {
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
    fromMs: start,
    toMs: end,
    hasRange: true,
    preset,
  };
}

function parseDateMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function publicRange(range) {
  return {
    from: range.from,
    to: range.to,
    hasRange: range.hasRange,
    preset: range.preset || "",
  };
}

function buildAPIAliases(apis) {
  const users = readUsers().users;
  const aliases = {};
  for (const apiName of Object.keys(apis || {})) {
    const masked = maskAPIKey(apiName);
    const hashed = hashAPIKey(apiName);
    const user = users.find((item) =>
      item.apiKeyPreview === apiName ||
      item.apiKeyPreview === masked ||
      item.apiKeyHash === hashed ||
      userAPIKeyRecords(item).some((record) =>
        record.preview === apiName ||
        record.preview === masked ||
        record.hash === hashed
      )
    );
    if (user && user.displayName) {
      aliases[apiName] = user.displayName;
    }
  }
  return aliases;
}

async function serveStatic(req, res, requestedPath) {
  let filePath = requestedPath === "/" ? "/index.html" : requestedPath;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, "");
  const absolutePath = path.join(PUBLIC_DIR, filePath);
  if (!absolutePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(absolutePath, (err, content) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (fallbackErr, fallback) => {
        if (fallbackErr) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(fallback);
      });
      return;
    }
    res.writeHead(200, { "Content-Type": contentType(absolutePath) });
    res.end(content);
  });
}

function readJSON(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error("request body too large"));
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function sendDownloadJSON(res, fileName, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename="${fileName}"`,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendDownloadText(res, fileName, body, contentTypeValue) {
  res.writeHead(200, {
    "Content-Type": contentTypeValue || "text/plain; charset=utf-8",
    "Content-Disposition": `attachment; filename="${fileName}"`,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendDownloadFile(res, fileName, filePath) {
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename="${fileName}"`,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readUsers() {
  try {
    const parsed = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
    if (!Array.isArray(parsed.users)) parsed.users = [];
    parsed.users = parsed.users.map(normaliseStoredUser).filter(Boolean);
    return parsed;
  } catch {
    return { users: [] };
  }
}

function writeUsers(store) {
  store.users = (store.users || []).map(normaliseStoredUser).filter(Boolean);
  fs.writeFileSync(USERS_FILE, JSON.stringify(store, null, 2));
}

function publicUser(user) {
  const normalised = normaliseStoredUser(user);
  return {
    id: normalised.id,
    displayName: normalised.displayName,
    role: normalised.role,
    apiKeyPreview: normalised.apiKeyPreview,
    apiKeys: userAPIKeyRecords(normalised).map((record) => ({
      id: record.id,
      preview: record.preview,
      label: record.label || "",
      createdAt: record.createdAt || "",
    })),
    group: normalised.group || "",
    note: normalised.note || "",
    limits: normaliseLimits(normalised.limits || {}),
    disabled: Boolean(normalised.disabled),
    createdAt: normalised.createdAt,
    updatedAt: normalised.updatedAt,
  };
}

function ensureDataFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify({ users: [] }, null, 2));
  }
  if (!fs.existsSync(AUDIT_FILE)) {
    fs.writeFileSync(AUDIT_FILE, "");
  }
  if (!fs.existsSync(SETTINGS_FILE)) {
    writeSettings(defaultSettings());
  }
  if (!fs.existsSync(AUTOMATION_STATE_FILE)) {
    fs.writeFileSync(AUTOMATION_STATE_FILE, JSON.stringify({}, null, 2));
  }
}

function normaliseStoredUser(user) {
  if (!user || typeof user !== "object") return null;
  const now = new Date().toISOString();
  const apiKeys = Array.isArray(user.apiKeys) ? user.apiKeys.map(normaliseAPIKeyRecord).filter(Boolean) : [];
  if (user.apiKeyHash && !apiKeys.some((item) => item.hash === user.apiKeyHash)) {
    apiKeys.unshift({
      id: stableKeyId(user.apiKeyHash),
      hash: user.apiKeyHash,
      preview: user.apiKeyPreview || "",
      label: "主 Key",
      createdAt: user.createdAt || now,
    });
  }
  const first = apiKeys[0];
  return {
    id: user.id || crypto.randomUUID(),
    displayName: String(user.displayName || user.apiKeyPreview || "User").trim(),
    role: normaliseRole(user.role),
    apiKeyHash: first ? first.hash : String(user.apiKeyHash || ""),
    apiKeyPreview: first ? first.preview : String(user.apiKeyPreview || ""),
    apiKeys,
    group: String(user.group || "").trim(),
    note: String(user.note || "").trim(),
    limits: normaliseLimits(user.limits || {}),
    disabled: Boolean(user.disabled),
    createdAt: user.createdAt || now,
    updatedAt: user.updatedAt || now,
  };
}

function normaliseAPIKeyRecord(record) {
  if (!record || typeof record !== "object") return null;
  const hash = String(record.hash || record.apiKeyHash || "").trim();
  if (!hash) return null;
  return {
    id: record.id || stableKeyId(hash),
    hash,
    preview: String(record.preview || record.apiKeyPreview || "").trim(),
    label: String(record.label || "").trim(),
    createdAt: record.createdAt || new Date().toISOString(),
  };
}

function makeAPIKeyRecord(apiKey, label) {
  const hash = hashAPIKey(apiKey);
  return {
    id: stableKeyId(hash),
    hash,
    preview: maskAPIKey(apiKey),
    label: String(label || "").trim(),
    createdAt: new Date().toISOString(),
  };
}

function ensureUserHasAPIKey(user, apiKey, label) {
  const record = makeAPIKeyRecord(apiKey, label);
  user.apiKeys = userAPIKeyRecords(user);
  const existing = user.apiKeys.find((item) => item.hash === record.hash);
  if (existing) {
    if (label && existing.label !== label) {
      existing.label = label;
      return true;
    }
    return false;
  }
  user.apiKeys.push(record);
  const first = user.apiKeys[0];
  user.apiKeyHash = first.hash;
  user.apiKeyPreview = first.preview;
  return true;
}

function userAPIKeyRecords(user) {
  const normalised = Array.isArray(user && user.apiKeys) ? user.apiKeys.map(normaliseAPIKeyRecord).filter(Boolean) : [];
  if (user && user.apiKeyHash && !normalised.some((item) => item.hash === user.apiKeyHash)) {
    normalised.unshift({
      id: stableKeyId(user.apiKeyHash),
      hash: user.apiKeyHash,
      preview: user.apiKeyPreview || "",
      label: "主 Key",
      createdAt: user.createdAt || new Date().toISOString(),
    });
  }
  return normalised;
}

function findUserByAPIKeyHash(users, apiKeyHash) {
  return (users || []).find((user) =>
    user.apiKeyHash === apiKeyHash ||
    userAPIKeyRecords(user).some((record) => record.hash === apiKeyHash)
  );
}

function stableKeyId(hash) {
  return "key_" + String(hash || "").slice(0, 16);
}

function defaultLimits() {
  return {
    dailyTokens: 0,
    monthlyTokens: 0,
    dailyRequests: 0,
    monthlyRequests: 0,
  };
}

function normaliseLimits(limits) {
  return {
    dailyTokens: nonNegativeNumber(limits.dailyTokens),
    monthlyTokens: nonNegativeNumber(limits.monthlyTokens),
    dailyRequests: nonNegativeNumber(limits.dailyRequests),
    monthlyRequests: nonNegativeNumber(limits.monthlyRequests),
  };
}

function nonNegativeNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function buildBackupPayload() {
  return {
    version: 1,
    app: "cpamc-sidecar-manager",
    createdAt: new Date().toISOString(),
    cpamcBaseUrl: CONFIG.cpamcBaseUrl,
    users: readUsers().users,
    settings: readSettings(),
  };
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((name) => safeBackupFileName(name))
    .map((name) => describeBackupFile(path.join(BACKUP_DIR, name)))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

function describeBackupFile(filePath) {
  const stat = fs.statSync(filePath);
  return {
    fileName: path.basename(filePath),
    size: stat.size,
    createdAt: stat.birthtime.toISOString(),
    updatedAt: stat.mtime.toISOString(),
  };
}

function importBackup(backup, mode) {
  if (!backup || !Array.isArray(backup.users)) {
    const err = new Error("invalid backup payload");
    err.statusCode = 400;
    throw err;
  }
  const importedUsers = backup.users.map(normaliseImportedUser).filter(Boolean);
  const store = mode === "replace" ? { users: [] } : readUsers();
  let added = 0;
  let updated = 0;
  for (const imported of importedUsers) {
    const existing = store.users.find((item) => item.apiKeyHash === imported.apiKeyHash || item.id === imported.id);
    if (existing) {
      existing.displayName = imported.displayName || existing.displayName;
      existing.role = normaliseRole(imported.role);
      existing.apiKeyPreview = imported.apiKeyPreview || existing.apiKeyPreview;
      existing.apiKeyHash = imported.apiKeyHash || existing.apiKeyHash;
      existing.apiKeys = imported.apiKeys || existing.apiKeys || [];
      existing.group = imported.group || "";
      existing.note = imported.note || "";
      existing.limits = normaliseLimits(imported.limits || {});
      existing.disabled = Boolean(imported.disabled);
      existing.updatedAt = new Date().toISOString();
      updated += 1;
    } else {
      store.users.push(imported);
      added += 1;
    }
  }
  writeUsers(store);
  let settingsImported = false;
  if (backup.settings && typeof backup.settings === "object") {
    writeSettings(mergeSettings(mode === "replace" ? defaultSettings() : readSettings(), backup.settings));
    settingsImported = true;
  }
  return { ok: true, mode, added, updated, total: store.users.length, settingsImported };
}

function normaliseImportedUser(user) {
  if (!user || (!user.apiKeyHash && !Array.isArray(user.apiKeys))) return null;
  const now = new Date().toISOString();
  return normaliseStoredUser({
    id: user.id || crypto.randomUUID(),
    displayName: String(user.displayName || user.apiKeyPreview || "User").trim(),
    role: normaliseRole(user.role),
    apiKeyHash: String(user.apiKeyHash),
    apiKeyPreview: String(user.apiKeyPreview || ""),
    apiKeys: Array.isArray(user.apiKeys) ? user.apiKeys : [],
    group: String(user.group || ""),
    note: String(user.note || ""),
    limits: normaliseLimits(user.limits || {}),
    disabled: Boolean(user.disabled),
    createdAt: user.createdAt || now,
    updatedAt: now,
  });
}

function safeBackupFileName(fileName) {
  const name = path.basename(String(fileName || ""));
  if (!/^backup-[\w.-]+\.json$/.test(name)) return "";
  return name;
}

function safeSnapshotFileName(fileName) {
  const name = path.basename(String(fileName || ""));
  if (!/^usage-snapshot-[\w.-]+\.json$/.test(name)) return "";
  return name;
}

function defaultSettings() {
  return {
    version: 1,
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
}

function readSettings() {
  try {
    return mergeSettings(defaultSettings(), JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")));
  } catch {
    return defaultSettings();
  }
}

function writeSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(mergeSettings(defaultSettings(), settings || {}), null, 2));
}

function mergeSettings(base, patch) {
  const output = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === "object" && !Array.isArray(value) && output[key] && typeof output[key] === "object" && !Array.isArray(output[key])) {
      output[key] = mergeSettings(output[key], value);
    } else if (value !== undefined) {
      output[key] = value;
    }
  }
  if (output.pricing && output.pricing.models) {
    const normalised = {};
    for (const [model, price] of Object.entries(output.pricing.models)) {
      normalised[model] = {
        inputPerMTok: Number(price.inputPerMTok || 0),
        outputPerMTok: Number(price.outputPerMTok || 0),
        cachedPerMTok: Number(price.cachedPerMTok || 0),
        reasoningPerMTok: Number(price.reasoningPerMTok || 0),
      };
    }
    output.pricing.models = normalised;
  }
  if (output.notifications) {
    output.notifications.dailyReportHour = Math.max(0, Math.min(23, Number(output.notifications.dailyReportHour ?? 9)));
  }
  return output;
}

function publicSettings(settings, user) {
  const copy = JSON.parse(JSON.stringify(settings || defaultSettings()));
  if (!user || user.role !== "admin") {
    if (copy.notifications) copy.notifications.webhookUrl = copy.notifications.webhookUrl ? "[configured]" : "";
  }
  return copy;
}

async function createUsageSnapshot(reason) {
  const upstream = await cpamcManagementFetchJSON("/v0/management/usage");
  const payload = {
    version: 1,
    app: "cpamc-sidecar-manager",
    reason: reason || "manual",
    createdAt: new Date().toISOString(),
    cpamcBaseUrl: CONFIG.cpamcBaseUrl,
    usage: upstream.usage || {},
  };
  const fileName = `usage-snapshot-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const filePath = path.join(SNAPSHOT_DIR, fileName);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  pruneUsageSnapshots();
  return describeUsageSnapshotFile(filePath);
}

function listUsageSnapshots() {
  if (!fs.existsSync(SNAPSHOT_DIR)) return [];
  return fs
    .readdirSync(SNAPSHOT_DIR)
    .filter((name) => safeSnapshotFileName(name))
    .map((name) => describeUsageSnapshotFile(path.join(SNAPSHOT_DIR, name)))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

function describeUsageSnapshotFile(filePath) {
  const stat = fs.statSync(filePath);
  let meta = {};
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    meta = {
      reason: raw.reason || "",
      totalRequests: Number((raw.usage || {}).total_requests || 0),
      totalTokens: Number((raw.usage || {}).total_tokens || 0),
      apiKeyCount: Object.keys((raw.usage || {}).apis || {}).length,
    };
  } catch {
    meta = {};
  }
  return {
    fileName: path.basename(filePath),
    size: stat.size,
    createdAt: stat.birthtime.toISOString(),
    updatedAt: stat.mtime.toISOString(),
    ...meta,
  };
}

function usageToCSV(usage) {
  const rows = [["api_key", "model", "timestamp", "failed", "latency_ms", "input_tokens", "output_tokens", "cached_tokens", "reasoning_tokens", "total_tokens", "source", "auth_index"]];
  for (const [apiName, apiStats] of Object.entries((usage && usage.apis) || {})) {
    for (const [modelName, modelStats] of Object.entries((apiStats && apiStats.models) || {})) {
      for (const detail of (modelStats && modelStats.details) || []) {
        const tokens = normaliseDetailTokens((detail && detail.tokens) || {});
        rows.push([
          maskAPIKey(apiName),
          modelName,
          detail.timestamp || "",
          detail.failed ? "true" : "false",
          detail.latency_ms || 0,
          tokens.input_tokens,
          tokens.output_tokens,
          tokens.cached_tokens,
          tokens.reasoning_tokens,
          tokens.total_tokens,
          detail.source || "",
          detail.auth_index || "",
        ]);
      }
    }
  }
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function csvCell(value) {
  const text = String(value == null ? "" : value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function writeAudit(action, session, details) {
  try {
    const user = session && session.user ? publicUser(session.user) : null;
    const event = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      action,
      actor: user ? {
        id: user.id,
        displayName: user.displayName,
        role: user.role,
        apiKeyPreview: user.apiKeyPreview,
      } : null,
      details: scrubAuditDetails(details || {}),
    };
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(event) + "\n");
  } catch (err) {
    console.error("failed to write audit log", err);
  }
}

function getClientIP(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || (req.socket && req.socket.remoteAddress) || "unknown";
}

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const item = loginAttempts.get(ip);
  if (!item) return { ok: true };
  if (item.blockedUntil && item.blockedUntil > now) {
    return { ok: false, retryAfterSeconds: Math.ceil((item.blockedUntil - now) / 1000) };
  }
  return { ok: true };
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const item = loginAttempts.get(ip) || { count: 0, firstAt: now, blockedUntil: 0 };
  if (now - item.firstAt > 10 * 60 * 1000) {
    item.count = 0;
    item.firstAt = now;
  }
  item.count += 1;
  if (item.count >= 8) {
    item.blockedUntil = now + 15 * 60 * 1000;
    item.count = 0;
  }
  loginAttempts.set(ip, item);
}

function resetLoginFailures(ip) {
  loginAttempts.delete(ip);
}

function listSessions() {
  const now = Date.now();
  return [...sessions.values()].filter((item) => item.expiresAt > now).map((item) => ({
    id: item.id,
    user: publicUser(item.user),
    apiKeyPreview: maskAPIKey(item.apiKey),
    createdAt: item.createdAt,
    lastSeenAt: item.lastSeenAt,
    expiresAt: new Date(item.expiresAt).toISOString(),
  })).sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
}

function revokeSession(sessionId) {
  for (const [token, item] of sessions.entries()) {
    if (item.id === sessionId) {
      sessions.delete(token);
      return true;
    }
  }
  return false;
}

async function sendWebhook(event, payload) {
  const settings = readSettings();
  const notifications = settings.notifications || {};
  if (!notifications.webhookEnabled || !notifications.webhookUrl) {
    return { ok: false, skipped: true, reason: "webhook disabled" };
  }
  try {
    const response = await httpPostJSON(notifications.webhookUrl, {
      event,
      app: (settings.appearance || {}).appName || "CPAMC Sidecar",
      payload,
      sentAt: new Date().toISOString(),
    });
    return { ok: response.ok, status: response.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function httpPostJSON(target, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const client = url.protocol === "https:" ? https : http;
    const data = Buffer.from(JSON.stringify(body));
    const req = client.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": data.length,
      },
      timeout: 10000,
    }, (res) => {
      res.resume();
      res.on("end", () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
    });
    req.on("timeout", () => req.destroy(new Error("webhook request timed out")));
    req.on("error", reject);
    req.end(data);
  });
}

function scrubAuditDetails(value) {
  if (Array.isArray(value)) return value.map(scrubAuditDetails);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/apiKeyHash|apiKey|token|secret|password/i.test(key)) {
      out[key] = key.toLowerCase().includes("preview") ? item : "[redacted]";
    } else {
      out[key] = scrubAuditDetails(item);
    }
  }
  return out;
}

function readAudit(limit) {
  if (!fs.existsSync(AUDIT_FILE)) return [];
  const lines = fs.readFileSync(AUDIT_FILE, "utf8").split(/\r?\n/).filter(Boolean);
  return lines.slice(-limit).reverse().map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

async function buildSystemStatus() {
  const status = {
    ok: true,
    app: {
      version: "0.1.0",
      node: process.version,
      uptime_seconds: Math.floor(process.uptime()),
      started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    },
    server: await collectServerMetrics(),
    cpamc: {
      base_url: CONFIG.cpamcBaseUrl,
      health: "unknown",
      management: "unknown",
      total_requests: 0,
      total_tokens: 0,
      api_key_count: 0,
    },
    storage: {
      user_count: readUsers().users.length,
      backup_count: listBackups().length,
      usage_snapshot_count: listUsageSnapshots().length,
      audit_events_recent: readAudit(1000).length,
    },
    auto_backup: {
      enabled: CONFIG.autoBackupEnabled,
      retention: CONFIG.autoBackupRetention,
    },
    usage_snapshots: {
      enabled: CONFIG.usageSnapshotEnabled,
      interval_minutes: CONFIG.usageSnapshotIntervalMinutes,
      retention: CONFIG.usageSnapshotRetention,
    },
  };
  try {
    const health = await cpamcFetchJSON("/healthz", {});
    status.cpamc.health = health.status || "ok";
  } catch (err) {
    status.ok = false;
    status.cpamc.health = "error";
    status.cpamc.health_error = err.message;
  }
  try {
    const usage = await cpamcManagementFetchJSON("/v0/management/usage");
    const snapshot = usage.usage || {};
    status.cpamc.management = "ok";
    status.cpamc.total_requests = Number(snapshot.total_requests || 0);
    status.cpamc.total_tokens = Number(snapshot.total_tokens || 0);
    status.cpamc.api_key_count = Object.keys(snapshot.apis || {}).length;
  } catch (err) {
    status.ok = false;
    status.cpamc.management = "error";
    status.cpamc.management_error = err.message;
  }
  return status;
}

async function collectServerMetrics() {
  const memoryTotal = os.totalmem();
  const memoryFree = os.freemem();
  const memoryUsed = Math.max(0, memoryTotal - memoryFree);
  const processMemory = process.memoryUsage();
  const cpuSnapshot = await sampleCPUUsage(250);
  const disks = await collectDiskMetrics();
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    type: os.type(),
    arch: os.arch(),
    uptime_seconds: Math.floor(os.uptime()),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    current_time: new Date().toISOString(),
    cpu: {
      model: (os.cpus()[0] && os.cpus()[0].model) || "unknown",
      cores: os.cpus().length,
      usage_percent: cpuSnapshot.usagePercent,
      load_average: os.loadavg(),
    },
    memory: {
      total: memoryTotal,
      free: memoryFree,
      used: memoryUsed,
      used_percent: memoryTotal ? memoryUsed / memoryTotal * 100 : 0,
    },
    process: {
      pid: process.pid,
      cwd: process.cwd(),
      exec_path: process.execPath,
      memory: {
        rss: processMemory.rss,
        heap_total: processMemory.heapTotal,
        heap_used: processMemory.heapUsed,
        external: processMemory.external,
        array_buffers: processMemory.arrayBuffers || 0,
      },
    },
    disks,
  };
}

function sampleCPUUsage(delayMs) {
  const first = cpuTimesSnapshot();
  return new Promise((resolve) => {
    setTimeout(() => {
      const second = cpuTimesSnapshot();
      const idle = second.idle - first.idle;
      const total = second.total - first.total;
      const usagePercent = total > 0 ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : 0;
      resolve({ usagePercent });
    }, delayMs);
  });
}

function cpuTimesSnapshot() {
  return os.cpus().reduce((acc, cpu) => {
    const times = cpu.times || {};
    const idle = Number(times.idle || 0);
    const total = Object.values(times).reduce((sum, value) => sum + Number(value || 0), 0);
    acc.idle += idle;
    acc.total += total;
    return acc;
  }, { idle: 0, total: 0 });
}

async function collectDiskMetrics() {
  if (os.platform() === "win32") {
    const disks = await collectWindowsDisks();
    if (disks.length) return disks;
  }
  return [{
    name: path.parse(ROOT).root || ROOT,
    mount: path.parse(ROOT).root || ROOT,
    filesystem: "",
    total: 0,
    free: 0,
    used: 0,
    used_percent: 0,
    note: "disk metrics unavailable on this platform without system tools",
  }];
}

function collectWindowsDisks() {
  const command = [
    "$items = Get-CimInstance Win32_LogicalDisk -Filter \"DriveType=3\" |",
    "Select-Object DeviceID,VolumeName,FileSystem,Size,FreeSpace;",
    "$items | ConvertTo-Json -Compress",
  ].join(" ");
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-Command", command], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) {
        resolve([]);
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        resolve(rows.map((row) => {
          const total = Number(row.Size || 0);
          const free = Number(row.FreeSpace || 0);
          const used = Math.max(0, total - free);
          return {
            name: row.DeviceID || "",
            mount: row.DeviceID || "",
            label: row.VolumeName || "",
            filesystem: row.FileSystem || "",
            total,
            free,
            used,
            used_percent: total ? used / total * 100 : 0,
          };
        }));
      } catch {
        resolve([]);
      }
    });
  });
}

function buildAlertsPayload(snapshot, session) {
  const store = readUsers();
  const users = session.user.role === "admin" ? store.users : [session.user];
  const alerts = [];
  const rows = [];
  for (const user of users) {
    const today = filterUsageByTime(filterUsageForUser(snapshot, user), presetToRange("today"));
    const month = filterUsageByTime(filterUsageForUser(snapshot, user), presetToRange("30d"));
    const limits = normaliseLimits(user.limits || {});
    const userAlerts = [
      makeLimitAlert(user, "dailyTokens", "今日 Token", today.total_tokens, limits.dailyTokens),
      makeLimitAlert(user, "monthlyTokens", "30天 Token", month.total_tokens, limits.monthlyTokens),
      makeLimitAlert(user, "dailyRequests", "今日请求", today.total_requests, limits.dailyRequests),
      makeLimitAlert(user, "monthlyRequests", "30天请求", month.total_requests, limits.monthlyRequests),
    ].filter(Boolean);
    alerts.push(...userAlerts);
    rows.push({
      user: publicUser(user),
      today: {
        requests: today.total_requests,
        tokens: today.total_tokens,
      },
      month: {
        requests: month.total_requests,
        tokens: month.total_tokens,
      },
      alerts: userAlerts,
    });
  }
  return { alerts, users: rows };
}

function makeLimitAlert(user, key, label, used, limit) {
  if (!limit) return null;
  const ratio = used / limit;
  if (ratio < 0.8) return null;
  return {
    id: `${user.id}:${key}`,
    level: ratio >= 1 ? "danger" : "warning",
    label,
    used,
    limit,
    ratio,
    user: publicUser(user),
    message: `${user.displayName} ${label} 已使用 ${Math.round(ratio * 100)}%`,
  };
}

function buildGroupStats(snapshot) {
  const groups = new Map();
  for (const user of readUsers().users) {
    const groupName = user.group || "未分组";
    const group = groups.get(groupName) || {
      name: groupName,
      users: 0,
      requests: 0,
      tokens: 0,
      models: new Set(),
      apiKeys: 0,
    };
    const scoped = filterUsageForUser(snapshot, user);
    group.users += 1;
    group.requests += scoped.total_requests;
    group.tokens += scoped.total_tokens;
    group.apiKeys += userAPIKeyRecords(user).length;
    for (const apiStats of Object.values(scoped.apis || {})) {
      for (const model of Object.keys(apiStats.models || {})) {
        group.models.add(model);
      }
    }
    groups.set(groupName, group);
  }
  return [...groups.values()].map((group) => ({
    name: group.name,
    users: group.users,
    requests: group.requests,
    tokens: group.tokens,
    models: group.models.size,
    apiKeys: group.apiKeys,
  })).sort((a, b) => b.tokens - a.tokens);
}

function buildInsightsPayload(usage, session) {
  const settings = readSettings();
  const modelRows = modelStatsRows(usage);
  const apiRows = apiStatsRows(usage);
  const anomalies = detectAnomalies(usage, modelRows, apiRows);
  const costs = estimateCosts(usage, settings.pricing || {});
  const efficiency = modelRows.map((row) => ({
    model: row.model,
    requests: row.requests,
    tokens: row.tokens,
    avgLatencyMs: row.avgLatencyMs,
    failureRate: row.failureRate,
    score: modelEfficiencyScore(row),
  })).sort((a, b) => b.score - a.score);
  const profiles = session.user.role === "admin" || session.user.role === "viewer" ? buildUserProfiles(usage) : [];
  return {
    anomalies,
    costs,
    efficiency,
    profiles,
    summary: {
      models: modelRows.length,
      apiKeys: apiRows.length,
      totalRequests: usage.total_requests,
      totalTokens: usage.total_tokens,
    },
  };
}

function modelStatsRows(usage) {
  const rows = new Map();
  for (const apiStats of Object.values((usage && usage.apis) || {})) {
    for (const [model, modelStats] of Object.entries((apiStats && apiStats.models) || {})) {
      const row = rows.get(model) || { model, requests: 0, tokens: 0, failed: 0, latencyMs: 0, latencyCount: 0, input: 0, output: 0, cached: 0, reasoning: 0 };
      row.requests += Number(modelStats.total_requests || 0);
      row.tokens += Number(modelStats.total_tokens || 0);
      for (const detail of modelStats.details || []) {
        const tokens = normaliseDetailTokens(detail.tokens || {});
        if (detail.failed) row.failed += 1;
        if (detail.latency_ms) {
          row.latencyMs += Number(detail.latency_ms || 0);
          row.latencyCount += 1;
        }
        row.input += tokens.input_tokens;
        row.output += tokens.output_tokens;
        row.cached += tokens.cached_tokens;
        row.reasoning += tokens.reasoning_tokens;
      }
      rows.set(model, row);
    }
  }
  return [...rows.values()].map((row) => ({
    ...row,
    avgLatencyMs: row.latencyCount ? row.latencyMs / row.latencyCount : 0,
    failureRate: row.requests ? row.failed / row.requests : 0,
  }));
}

function apiStatsRows(usage) {
  return Object.entries((usage && usage.apis) || {}).map(([api, stats]) => ({
    api,
    requests: Number(stats.total_requests || 0),
    tokens: Number(stats.total_tokens || 0),
  }));
}

function detectAnomalies(usage, modelRows, apiRows) {
  const anomalies = [];
  const totalRequests = Number(usage.total_requests || 0);
  const failureRate = totalRequests ? Number(usage.failure_count || 0) / totalRequests : 0;
  if (failureRate >= 0.15 && totalRequests >= 10) {
    anomalies.push({ level: "danger", type: "failure_rate", title: "失败率偏高", message: `当前失败率 ${Math.round(failureRate * 100)}%` });
  }
  for (const row of modelRows) {
    if (row.failureRate >= 0.2 && row.requests >= 5) anomalies.push({ level: "warning", type: "model_failure", title: "模型失败率偏高", message: `${row.model} 失败率 ${Math.round(row.failureRate * 100)}%` });
    if (row.avgLatencyMs >= 30000 && row.requests >= 3) anomalies.push({ level: "warning", type: "latency", title: "模型延迟偏高", message: `${row.model} 平均延迟 ${(row.avgLatencyMs / 1000).toFixed(1)}s` });
  }
  const apiMax = apiRows.reduce((max, row) => Math.max(max, row.tokens), 0);
  for (const row of apiRows) {
    if (apiMax > 0 && row.tokens / apiMax >= 0.8 && apiRows.length > 1) anomalies.push({ level: "info", type: "api_concentration", title: "用量集中", message: `${maskAPIKey(row.api)} 消耗接近最高 Key` });
  }
  return anomalies.slice(0, 20);
}

function estimateCosts(usage, pricing) {
  const currency = pricing.currency || "USD";
  const byModel = [];
  let total = 0;
  for (const row of modelStatsRows(usage)) {
    const price = (pricing.models || {})[row.model] || {};
    const cost =
      row.input / 1000000 * Number(price.inputPerMTok || 0) +
      row.output / 1000000 * Number(price.outputPerMTok || 0) +
      row.cached / 1000000 * Number(price.cachedPerMTok || 0) +
      row.reasoning / 1000000 * Number(price.reasoningPerMTok || 0);
    total += cost;
    byModel.push({ model: row.model, cost, tokens: row.tokens, requests: row.requests });
  }
  return { currency, total, byModel: byModel.sort((a, b) => b.cost - a.cost) };
}

function modelEfficiencyScore(row) {
  const latencyPenalty = Math.min(50, (row.avgLatencyMs || 0) / 1000);
  const failurePenalty = row.failureRate * 100;
  const tokenLoadPenalty = Math.min(25, Math.log10(Math.max(row.tokens, 1)) * 3);
  return Math.max(0, Math.round(100 - latencyPenalty - failurePenalty - tokenLoadPenalty));
}

function buildUserProfiles(usage) {
  const users = readUsers().users;
  return users.map((user) => {
    const scoped = filterUsageForUser(usage, user);
    const models = modelStatsRows(scoped).sort((a, b) => b.tokens - a.tokens);
    const activeHours = {};
    for (const apiStats of Object.values(scoped.apis || {})) {
      for (const modelStats of Object.values(apiStats.models || {})) {
        for (const detail of modelStats.details || []) {
          const hour = detail.timestamp ? new Date(detail.timestamp).getHours() : -1;
          if (hour >= 0) activeHours[hour] = (activeHours[hour] || 0) + 1;
        }
      }
    }
    const topHour = Object.entries(activeHours).sort((a, b) => b[1] - a[1])[0];
    return {
      user: publicUser(user),
      requests: scoped.total_requests,
      tokens: scoped.total_tokens,
      topModels: models.slice(0, 3).map((row) => ({ model: row.model, tokens: row.tokens, requests: row.requests })),
      activeHour: topHour ? Number(topHour[0]) : null,
    };
  }).sort((a, b) => b.tokens - a.tokens);
}

function buildDailyReport(usage, session) {
  const modelRows = modelStatsRows(usage).sort((a, b) => b.tokens - a.tokens);
  const apiRows = apiStatsRows(usage).sort((a, b) => b.tokens - a.tokens);
  return {
    title: "CPAMC Daily Report",
    generatedAt: new Date().toISOString(),
    scope: session.user.role === "admin" || session.user.role === "viewer" ? "all" : "own",
    summary: {
      requests: usage.total_requests,
      success: usage.success_count,
      failed: usage.failure_count,
      tokens: usage.total_tokens,
    },
    topModels: modelRows.slice(0, 10).map((row) => ({ model: row.model, requests: row.requests, tokens: row.tokens, failureRate: row.failureRate })),
    topApiKeys: apiRows.slice(0, 10).map((row) => ({ apiKey: maskAPIKey(row.api), requests: row.requests, tokens: row.tokens })),
    anomalies: detectAnomalies(usage, modelRows, apiRows),
  };
}

function scheduleAutoBackup() {
  if (!CONFIG.autoBackupEnabled) return;
  const run = () => {
    try {
      const fileName = `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      const filePath = path.join(BACKUP_DIR, fileName);
      fs.writeFileSync(filePath, JSON.stringify(buildBackupPayload(), null, 2));
      pruneBackups();
      writeAudit("backup_auto_create", null, { fileName });
    } catch (err) {
      console.error("auto backup failed", err);
    }
  };
  setTimeout(run, 30000);
  setInterval(run, 24 * 60 * 60 * 1000);
}

function scheduleUsageSnapshot() {
  if (!CONFIG.usageSnapshotEnabled) return;
  const interval = Math.max(5, CONFIG.usageSnapshotIntervalMinutes || 60) * 60 * 1000;
  const run = async () => {
    try {
      const snapshot = await createUsageSnapshot("scheduled");
      writeAudit("usage_snapshot_auto_create", null, { fileName: snapshot.fileName });
    } catch (err) {
      console.error("usage snapshot failed", err);
    }
  };
  setTimeout(run, 60000);
  setInterval(run, interval);
}

function scheduleDailyReport() {
  const run = async () => {
    const settings = readSettings();
    const notifications = settings.notifications || {};
    if (!notifications.dailyReportEnabled || !notifications.webhookEnabled || !notifications.webhookUrl) return;
    const hour = Math.max(0, Math.min(23, Number(notifications.dailyReportHour ?? 9)));
    const now = new Date();
    if (now.getHours() < hour) return;
    const day = localDateKey(now);
    const automationState = readAutomationState();
    if (automationState.dailyReportDate === day) return;
    try {
      const upstream = await cpamcManagementFetchJSON("/v0/management/usage");
      const usage = filterUsageByTime(upstream.usage || {}, presetToRange("today"));
      const report = buildDailyReport(usage, { user: { role: "admin", displayName: "system", apiKeyPreview: "" } });
      const result = await sendWebhook("daily_report", report);
      writeAudit("report_auto_notify", null, { type: "daily", result });
      if (result.ok) {
        automationState.dailyReportDate = day;
        automationState.dailyReportSentAt = new Date().toISOString();
        writeAutomationState(automationState);
      }
    } catch (err) {
      writeAudit("report_auto_notify_failed", null, { type: "daily", error: err.message });
      console.error("daily report notification failed", err);
    }
  };
  setTimeout(run, 90000);
  setInterval(run, 30 * 60 * 1000);
}

function readAutomationState() {
  try {
    return JSON.parse(fs.readFileSync(AUTOMATION_STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeAutomationState(state) {
  fs.writeFileSync(AUTOMATION_STATE_FILE, JSON.stringify(state || {}, null, 2));
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function pruneUsageSnapshots() {
  const retention = Math.max(1, CONFIG.usageSnapshotRetention || 72);
  const snapshots = listUsageSnapshots().sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  for (const snapshot of snapshots.slice(retention)) {
    const filePath = path.join(SNAPSHOT_DIR, snapshot.fileName);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
}

function pruneBackups() {
  const retention = Math.max(1, CONFIG.autoBackupRetention || 14);
  const backups = listBackups().sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  for (const backup of backups.slice(retention)) {
    const filePath = path.join(BACKUP_DIR, backup.fileName);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
}

function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function hashAPIKey(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function maskAPIKey(value) {
  const text = String(value || "").trim();
  if (text.length <= 8) return text ? `${text.slice(0, 2)}****` : "";
  return `${text.slice(0, 3)}${"*".repeat(6)}${text.slice(-2)}`;
}

function normaliseRole(value) {
  const role = String(value || "").toLowerCase();
  if (role === "admin") return "admin";
  if (role === "viewer" || role === "readonly" || role === "read-only") return "viewer";
  return "user";
}

function parseBool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function splitCSV(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
  }[ext] || "application/octet-stream";
}

function buildAlertsPayload(snapshot, session) {
  const store = readUsers();
  const users = session.user.role === "admin" ? store.users : [session.user];
  const alerts = [];
  const rows = [];
  for (const user of users) {
    const today = filterUsageByTime(filterUsageForUser(snapshot, user), presetToRange("today"));
    const month = filterUsageByTime(filterUsageForUser(snapshot, user), presetToRange("30d"));
    const limits = normaliseLimits(user.limits || {});
    const userAlerts = [
      makeLimitAlert(user, "dailyTokens", "今日 Token", today.total_tokens, limits.dailyTokens),
      makeLimitAlert(user, "monthlyTokens", "30 天 Token", month.total_tokens, limits.monthlyTokens),
      makeLimitAlert(user, "dailyRequests", "今日请求", today.total_requests, limits.dailyRequests),
      makeLimitAlert(user, "monthlyRequests", "30 天请求", month.total_requests, limits.monthlyRequests),
    ].filter(Boolean);
    alerts.push(...userAlerts);
    rows.push({
      user: publicUser(user),
      today: {
        requests: today.total_requests,
        tokens: today.total_tokens,
      },
      month: {
        requests: month.total_requests,
        tokens: month.total_tokens,
      },
      alerts: userAlerts,
    });
  }
  maybeAutoDisableExceededUsers(store, alerts);
  return { alerts, users: rows };
}

function makeLimitAlert(user, key, label, used, limit) {
  if (!limit) return null;
  const ratio = used / limit;
  if (ratio < 0.8) return null;
  return {
    id: `${user.id}:${key}`,
    level: ratio >= 1 ? "danger" : "warning",
    label,
    used,
    limit,
    ratio,
    user: publicUser(user),
    message: `${user.displayName} ${label} 已使用 ${Math.round(ratio * 100)}%`,
  };
}

function maybeAutoDisableExceededUsers(store, alerts) {
  const settings = readSettings();
  if (!((settings.automation || {}).autoDisableOnLimitExceeded)) return;
  const exceededUserIds = new Set((alerts || [])
    .filter((alert) => alert.level === "danger" && alert.user && alert.user.role === "user")
    .map((alert) => alert.user.id));
  if (!exceededUserIds.size) return;
  let changed = false;
  for (const user of store.users || []) {
    if (!exceededUserIds.has(user.id) || user.disabled || user.role !== "user") continue;
    user.disabled = true;
    user.updatedAt = new Date().toISOString();
    changed = true;
    writeAudit("user_auto_disabled_limit", null, { user: publicUser(user) });
  }
  if (changed) writeUsers(store);
}

function buildGroupStats(snapshot) {
  const groups = new Map();
  for (const user of readUsers().users) {
    const groupName = user.group || "未分组";
    const group = groups.get(groupName) || {
      name: groupName,
      users: 0,
      requests: 0,
      tokens: 0,
      models: new Set(),
      apiKeys: 0,
    };
    const scoped = filterUsageForUser(snapshot, user);
    group.users += 1;
    group.requests += scoped.total_requests;
    group.tokens += scoped.total_tokens;
    group.apiKeys += userAPIKeyRecords(user).length;
    for (const apiStats of Object.values(scoped.apis || {})) {
      for (const model of Object.keys(apiStats.models || {})) {
        group.models.add(model);
      }
    }
    groups.set(groupName, group);
  }
  return [...groups.values()].map((group) => ({
    name: group.name,
    users: group.users,
    requests: group.requests,
    tokens: group.tokens,
    models: group.models.size,
    apiKeys: group.apiKeys,
  })).sort((a, b) => b.tokens - a.tokens);
}

function detectAnomalies(usage, modelRows, apiRows) {
  const anomalies = [];
  const totalRequests = Number(usage.total_requests || 0);
  const failureRate = totalRequests ? Number(usage.failure_count || 0) / totalRequests : 0;
  if (failureRate >= 0.15 && totalRequests >= 10) {
    anomalies.push({ level: "danger", type: "failure_rate", title: "失败率偏高", message: `当前失败率 ${Math.round(failureRate * 100)}%` });
  }
  for (const row of modelRows) {
    if (row.failureRate >= 0.2 && row.requests >= 5) {
      anomalies.push({ level: "warning", type: "model_failure", title: "模型失败率偏高", message: `${row.model} 失败率 ${Math.round(row.failureRate * 100)}%` });
    }
    if (row.avgLatencyMs >= 30000 && row.requests >= 3) {
      anomalies.push({ level: "warning", type: "latency", title: "模型延迟偏高", message: `${row.model} 平均延迟 ${(row.avgLatencyMs / 1000).toFixed(1)}s` });
    }
  }
  const apiMax = apiRows.reduce((max, row) => Math.max(max, row.tokens), 0);
  for (const row of apiRows) {
    if (apiMax > 0 && row.tokens / apiMax >= 0.8 && apiRows.length > 1) {
      anomalies.push({ level: "info", type: "api_concentration", title: "用量集中", message: `${maskAPIKey(row.api)} 消耗接近最高 Key` });
    }
  }
  return anomalies.slice(0, 20);
}
