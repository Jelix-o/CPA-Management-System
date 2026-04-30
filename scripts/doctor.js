const fs = require("fs");
const net = require("net");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env");

function readEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const env = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    env[key] = value;
  }
  return env;
}

function ok(message) {
  console.log(`[OK] ${message}`);
}

function warn(message) {
  console.log(`[WARN] ${message}`);
}

function fail(message) {
  console.log(`[FAIL] ${message}`);
  failures += 1;
}

function parseMajor(version) {
  const match = String(version || "").match(/^v?(\d+)/);
  return match ? Number(match[1]) : 0;
}

function canWriteDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, `.write-test-${Date.now()}`);
  fs.writeFileSync(probe, "ok");
  fs.unlinkSync(probe);
}

let failures = 0;
const env = { ...readEnv(ENV_PATH), ...process.env };
const nodeMajor = parseMajor(process.version);
const dataDir = path.resolve(env.APP_DATA_DIR || path.join(ROOT, "data"));
const host = env.APP_HOST || "0.0.0.0";
const port = Number(env.APP_PORT || 8787);

console.log("CPAMC Sidecar deployment doctor");
console.log(`Root: ${ROOT}`);

if (nodeMajor >= 18) ok(`Node.js ${process.version}`);
else fail(`Node.js ${process.version} is too old. Use Node.js 18 or newer.`);

if (fs.existsSync(path.join(ROOT, "server.js"))) ok("server.js exists");
else fail("server.js is missing");

if (fs.existsSync(path.join(ROOT, "public", "app.js")) && fs.existsSync(path.join(ROOT, "public", "styles.css"))) {
  ok("public assets exist");
} else {
  fail("public/app.js or public/styles.css is missing");
}

if (!fs.existsSync(ENV_PATH) && !process.env.CPAMC_BASE_URL) {
  warn(".env is missing. This is fine under systemd if EnvironmentFile is configured.");
}

if (env.APP_SESSION_SECRET && env.APP_SESSION_SECRET.length >= 32 && !/change-this/i.test(env.APP_SESSION_SECRET)) {
  ok("APP_SESSION_SECRET is set");
} else {
  fail("APP_SESSION_SECRET should be a unique random string with at least 32 characters");
}

if (env.CPAMC_BASE_URL && /^https?:\/\//i.test(env.CPAMC_BASE_URL)) ok("CPAMC_BASE_URL is set");
else fail("CPAMC_BASE_URL must be set, for example http://127.0.0.1:8317");

if (env.CPAMC_MANAGEMENT_KEY && !/change-this/i.test(env.CPAMC_MANAGEMENT_KEY)) ok("CPAMC_MANAGEMENT_KEY is set");
else fail("CPAMC_MANAGEMENT_KEY must be set");

if (Number.isInteger(port) && port > 0 && port < 65536) ok(`APP_PORT=${port}`);
else fail(`APP_PORT is invalid: ${env.APP_PORT}`);

try {
  canWriteDirectory(dataDir);
  ok(`data directory is writable: ${dataDir}`);
} catch (err) {
  fail(`data directory is not writable: ${dataDir} (${err.message})`);
}

const server = net.createServer();
server.once("error", (err) => {
  if (err.code === "EADDRINUSE") warn(`port ${port} is already in use`);
  else fail(`cannot check port ${port}: ${err.message}`);
  finish();
});
server.once("listening", () => {
  server.close(() => {
    ok(`port ${port} is available on ${host}`);
    finish();
  });
});
server.listen(port, host);

function finish() {
  if (failures) {
    console.log(`Doctor finished with ${failures} failure(s).`);
    process.exitCode = 1;
  } else {
    console.log("Doctor finished successfully.");
  }
}
