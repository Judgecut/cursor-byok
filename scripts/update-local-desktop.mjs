import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_DISPLAY_NAME = "Cursor BYOK";
const EXECUTABLE_NAME = "cursor-byok-desktop.exe";
const LICENSE_FILES = ["LICENSE", "THIRD-PARTY-LICENSES.md"];

const FRONTEND_INPUT_DIRS = ["apps/desktop/src", "apps/desktop/plugins"];
const FRONTEND_INPUT_FILES = [
  "apps/desktop/index.html",
  "apps/desktop/package.json",
  "apps/desktop/package-lock.json",
  "apps/desktop/tsconfig.json",
  "apps/desktop/tsconfig.node.json",
  "apps/desktop/vite.config.ts",
];

const BACKEND_INPUT_DIRS = [
  "apps/desktop/src-tauri/src",
  "apps/desktop/src-tauri/icons",
  "apps/desktop/src-tauri/capabilities",
  "apps/desktop/src-tauri/permissions",
  "server/src",
  "server/migrations",
  "server/plugins",
  "server/prompt",
  "crates/semble-core/src",
  "protocols",
];
const BACKEND_INPUT_FILES = [
  "Cargo.toml",
  "Cargo.lock",
  ".cargo/config.toml",
  "rust-toolchain.toml",
  "LICENSE",
  "THIRD-PARTY-LICENSES.md",
  "apps/desktop/src-tauri/Cargo.toml",
  "apps/desktop/src-tauri/build.rs",
  "apps/desktop/src-tauri/tauri.conf.json",
  "server/Cargo.toml",
  "server/build.rs",
  "crates/semble-core/Cargo.toml",
];

function logStep(message) {
  console.log(`[update-local] ${message}`);
}

function logDetail(message) {
  console.log(`  ${message}`);
}

function formatLocalTime(mtimeMs) {
  const date = new Date(mtimeMs);
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

export function parseArgs(argv) {
  const options = {
    targetDir: undefined,
    force: false,
    noLaunch: false,
    checkOnly: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const normalized = raw.toLowerCase();

    if (normalized === "-h" || normalized === "--help" || normalized === "-help") {
      options.help = true;
      continue;
    }
    if (normalized === "--force" || normalized === "-force") {
      options.force = true;
      continue;
    }
    if (normalized === "--no-launch" || normalized === "-nolaunch") {
      options.noLaunch = true;
      continue;
    }
    if (normalized === "--check-only" || normalized === "-checkonly") {
      options.checkOnly = true;
      continue;
    }
    if (normalized.startsWith("--target-dir=") || normalized.startsWith("-targetdir=")) {
      const value = raw.slice(raw.indexOf("=") + 1).trim();
      if (!value) throw new Error(`${raw} 缺少目录路径`);
      options.targetDir = value;
      continue;
    }
    if (normalized === "--target-dir" || normalized === "-targetdir") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`${raw} 后面需要提供目标目录路径`);
      }
      options.targetDir = value.trim();
      index += 1;
      continue;
    }

    throw new Error(`未知参数：${raw}（使用 --help 查看用法）`);
  }

  return options;
}

function printHelp() {
  console.log(`用法：
  node scripts/update-local-desktop.mjs [选项]
  .\\scripts\\update-local-desktop.cmd [选项]

功能：
  1. 自动探测本地 Cursor BYOK 安装目录（或通过 --target-dir 指定）。
  2. 检查 frontend dist 与 target/release/${EXECUTABLE_NAME} 是否缺失或落后于源码；
     如需编译，自动执行 npm --prefix apps/desktop run tauri:build -- --no-bundle。
  3. 对比 SHA-256；若产物有变化（或指定 --force），先暂存新程序再停止旧进程，
     带备份与回滚保护替换本地程序和许可文件，并按需重新启动。

选项：
  --check-only, -CheckOnly      仅检查是否需要编译与替换，不实际构建或修改本地文件
  --force, -Force               强制重新编译并强制替换本地程序
  --no-launch, -NoLaunch        替换完成后不自动启动 Cursor BYOK
  --target-dir, -TargetDir <目录> 手动指定本地 Cursor BYOK 安装目录
  -h, --help, -Help             显示此帮助信息`);
}

function unquoteTrim(value) {
  return value.trim().replace(/^"(.*)"$/, "$1").trim();
}

export function extractUninstallDir(rawValue) {
  let trimmed = rawValue.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('"')) {
    const closingQuote = trimmed.indexOf('"', 1);
    if (closingQuote > 1) {
      trimmed = trimmed.slice(1, closingQuote);
    }
  } else {
    const exeMatch = trimmed.match(/^(.*?\.exe)(?:\s|$)/i);
    if (exeMatch) {
      trimmed = exeMatch[1];
    }
  }

  trimmed = unquoteTrim(trimmed);
  if (!trimmed) return null;
  const parent = dirname(trimmed);
  return parent && parent !== "." ? parent : null;
}

export function parseRegistryInstallDirs(regOutput) {
  const dirs = [];
  if (!regOutput) return dirs;

  const lines = regOutput.split(/\r?\n/);
  for (const line of lines) {
    const installMatch = line.match(/^\s*InstallLocation\s+REG_\w+\s+(.+)$/i);
    if (installMatch) {
      const candidate = unquoteTrim(installMatch[1]);
      if (candidate) dirs.push(candidate);
      continue;
    }

    const uninstallMatch = line.match(/^\s*UninstallString\s+REG_\w+\s+(.+)$/i);
    if (uninstallMatch) {
      const candidate = extractUninstallDir(uninstallMatch[1]);
      if (candidate) dirs.push(candidate);
    }
  }

  return dirs;
}

function defaultQueryWindowsRegistry() {
  const roots = [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ];
  const outputs = [];

  for (const root of roots) {
    const directKey = `${root}\\${APP_DISPLAY_NAME}`;
    try {
      const direct = execFileSync("reg.exe", ["query", directKey], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      if (direct) outputs.push(direct);
      continue;
    } catch {
      // Ignore missing subkey and fall back to search under root.
    }

    try {
      const searched = execFileSync(
        "reg.exe",
        ["query", root, "/s", "/f", APP_DISPLAY_NAME, "/d", "/e"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        },
      );
      if (searched) outputs.push(searched);
    } catch {
      // Ignore missing registry root or no matches.
    }
  }

  return outputs;
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function resolveInstallDirectory({
  explicitDir,
  queryRegistry = defaultQueryWindowsRegistry,
  env = process.env,
  checkDir = isDirectory,
  checkFile = isFile,
  resolvePath = resolve,
} = {}) {
  if (explicitDir) {
    const cleaned = unquoteTrim(explicitDir);
    const resolved = resolvePath(cleaned);
    if (!checkDir(resolved)) {
      throw new Error(`指定的目标目录不存在：${resolved}`);
    }
    return resolved;
  }

  const rawCandidates = [];
  for (const regOutput of queryRegistry()) {
    rawCandidates.push(...parseRegistryInstallDirs(regOutput));
  }

  if (env.LOCALAPPDATA) {
    rawCandidates.push(resolvePath(env.LOCALAPPDATA, APP_DISPLAY_NAME));
  }
  if (env.ProgramFiles) {
    rawCandidates.push(resolvePath(env.ProgramFiles, APP_DISPLAY_NAME));
  }

  const existingDirs = [];
  const seen = new Set();

  for (const candidate of rawCandidates) {
    if (!candidate) continue;
    const resolved = resolvePath(candidate);
    const dedupeKey = resolved.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    if (!checkDir(resolved)) continue;
    existingDirs.push(resolved);
    if (checkFile(resolvePath(resolved, EXECUTABLE_NAME))) {
      return resolved;
    }
  }

  if (existingDirs.length > 0) {
    return existingDirs[0];
  }

  throw new Error("未找到本地 Cursor BYOK 安装目录。请先运行安装包安装，或通过 --target-dir 指定目录。");
}

function scanNewestFile(repoRoot, relativeDirs, relativeFiles) {
  let newestPath = null;
  let newestMtimeMs = -1;

  function visitDir(dirPath) {
    let entries;
    try {
      entries = readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = resolve(dirPath, entry.name);
      if (entry.isDirectory()) {
        visitDir(fullPath);
      } else if (entry.isFile()) {
        const stats = statSync(fullPath);
        if (stats.mtimeMs > newestMtimeMs) {
          newestMtimeMs = stats.mtimeMs;
          newestPath = fullPath;
        }
      }
    }
  }

  for (const relDir of relativeDirs) {
    const fullDir = resolve(repoRoot, relDir);
    if (isDirectory(fullDir)) {
      visitDir(fullDir);
    }
  }

  for (const relFile of relativeFiles) {
    const fullFile = resolve(repoRoot, relFile);
    if (!isFile(fullFile)) continue;
    const stats = statSync(fullFile);
    if (stats.mtimeMs > newestMtimeMs) {
      newestMtimeMs = stats.mtimeMs;
      newestPath = fullFile;
    }
  }

  return newestPath ? { path: newestPath, mtimeMs: newestMtimeMs } : null;
}

function toRepoRelative(repoRoot, filePath) {
  const normalizedRoot = resolve(repoRoot);
  if (filePath.toLowerCase().startsWith(normalizedRoot.toLowerCase())) {
    return filePath.slice(normalizedRoot.length).replace(/^[\\/]+/, "").replace(/\\/g, "/");
  }
  return filePath;
}

export function inspectBuildRequirement({
  repoRoot,
  sourceExe = resolve(repoRoot, "target", "release", EXECUTABLE_NAME),
  frontendDistIndex = resolve(repoRoot, "apps", "desktop", "dist", "index.html"),
  force = false,
} = {}) {
  if (force) {
    return {
      required: true,
      reason: "已指定 --force，执行强制重新编译",
    };
  }

  if (!isFile(sourceExe)) {
    return {
      required: true,
      reason: `未检测到 Release 可执行文件（${sourceExe}）`,
    };
  }

  if (!isFile(frontendDistIndex)) {
    return {
      required: true,
      reason: `未检测到前端构建产物（${frontendDistIndex}）`,
    };
  }

  const exeMtimeMs = statSync(sourceExe).mtimeMs;
  const distMtimeMs = statSync(frontendDistIndex).mtimeMs;

  const newestFrontend = scanNewestFile(repoRoot, FRONTEND_INPUT_DIRS, FRONTEND_INPUT_FILES);
  if (newestFrontend && newestFrontend.mtimeMs > distMtimeMs) {
    return {
      required: true,
      reason: `前端源码 ${toRepoRelative(repoRoot, newestFrontend.path)}（${formatLocalTime(newestFrontend.mtimeMs)}）晚于前端 dist（${formatLocalTime(distMtimeMs)}）`,
    };
  }

  if (distMtimeMs > exeMtimeMs) {
    return {
      required: true,
      reason: `前端 dist（${formatLocalTime(distMtimeMs)}）晚于 Release 产物（${formatLocalTime(exeMtimeMs)}）`,
    };
  }

  const newestBackend = scanNewestFile(repoRoot, BACKEND_INPUT_DIRS, BACKEND_INPUT_FILES);
  let newestAll = newestBackend;
  if (newestFrontend && (!newestAll || newestFrontend.mtimeMs > newestAll.mtimeMs)) {
    newestAll = newestFrontend;
  }

  if (newestAll && newestAll.mtimeMs > exeMtimeMs) {
    return {
      required: true,
      reason: `源码 ${toRepoRelative(repoRoot, newestAll.path)}（${formatLocalTime(newestAll.mtimeMs)}）晚于当前 Release 产物（${formatLocalTime(exeMtimeMs)}）`,
    };
  }

  return {
    required: false,
    reason: `当前 Release 产物已是最新（${formatLocalTime(exeMtimeMs)}）`,
  };
}

function runCommandChecked(command, args, cwd, label) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    windowsHide: false,
  });

  if (result.error) {
    throw new Error(`${label} 启动失败：${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${label} 执行失败，退出码：${result.status ?? "unknown"}`);
  }
}

function assertCommandAvailable(command, args = ["--version"], displayName = command) {
  const result = spawnSync(command, args, {
    stdio: "ignore",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`未找到命令 '${displayName}'，请先安装并确认已加入 PATH。`);
  }
}

export function invokeDesktopReleaseBuild(repoRoot) {
  const desktopDir = resolve(repoRoot, "apps", "desktop");
  const nodeModulesDir = resolve(desktopDir, "node_modules");
  const isWindows = process.platform === "win32";
  const comSpec = process.env.ComSpec || "cmd.exe";

  assertCommandAvailable("cargo", ["--version"], "cargo");
  if (isWindows) {
    assertCommandAvailable(comSpec, ["/d", "/c", "npm", "--version"], "npm");
  } else {
    assertCommandAvailable("npm", ["--version"], "npm");
  }

  if (!isDirectory(nodeModulesDir)) {
    logStep("未检测到前端依赖，先执行 npm ci...");
    if (isWindows) {
      runCommandChecked(comSpec, ["/d", "/c", "npm", "ci"], desktopDir, "npm ci");
    } else {
      runCommandChecked("npm", ["ci"], desktopDir, "npm ci");
    }
  }

  logStep("开始执行桌面端 Release 编译（npm --prefix apps/desktop run tauri:build -- --no-bundle）...");
  if (isWindows) {
    runCommandChecked(
      comSpec,
      ["/d", "/c", "npm", "run", "tauri:build", "--", "--no-bundle"],
      desktopDir,
      "tauri:build",
    );
  } else {
    runCommandChecked(
      "npm",
      ["run", "tauri:build", "--", "--no-bundle"],
      desktopDir,
      "tauri:build",
    );
  }
}

export function parseTasklistCsv(csvOutput, imageName = EXECUTABLE_NAME) {
  const pids = [];
  if (!csvOutput) return pids;

  const prefix = `"${imageName.toLowerCase()}","`;
  for (const rawLine of csvOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.toLowerCase().startsWith(prefix)) continue;
    const endQuote = line.indexOf('"', prefix.length);
    if (endQuote <= prefix.length) continue;
    const pid = Number.parseInt(line.slice(prefix.length, endQuote), 10);
    if (Number.isInteger(pid) && pid > 0) {
      pids.push(pid);
    }
  }
  return pids;
}

export function listRunningDesktopPids() {
  if (process.platform !== "win32") return [];
  const output = execFileSync(
    "tasklist.exe",
    ["/FI", `IMAGENAME eq ${EXECUTABLE_NAME}`, "/FO", "CSV", "/NH"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    },
  );
  return parseTasklistCsv(output);
}

export async function stopRunningDesktopProcesses({
  listPids = listRunningDesktopPids,
  killAll = () => {
    spawnSync("taskkill.exe", ["/IM", EXECUTABLE_NAME, "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  },
  wait = sleep,
  timeoutMs = 15000,
} = {}) {
  const initialPids = listPids();
  if (initialPids.length === 0) {
    return false;
  }

  logStep(`检测到正在运行的 Cursor BYOK 进程（${initialPids.length} 个），正在停止以解除文件占用...`);
  killAll();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (listPids().length === 0) {
      await wait(300);
      return true;
    }
    await wait(200);
  }

  throw new Error(`等待 ${EXECUTABLE_NAME} 进程退出超时，请手动退出托盘图标后重试。`);
}

export async function hashFileSha256(filePath) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectPromise);
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

export async function retryFileOperation(action, { maxAttempts = 12, delayMs = 250, wait = sleep } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (attempt >= maxAttempts) throw error;
      await wait(delayMs);
    }
  }
}

export function syncLicenseFiles({ repoRoot, installDir }) {
  const licensesSubDir = resolve(installDir, "licenses");
  const hasLicensesSubDir = isDirectory(licensesSubDir);

  for (const fileName of LICENSE_FILES) {
    const src = resolve(repoRoot, fileName);
    if (!isFile(src)) continue;

    if (hasLicensesSubDir) {
      copyFileSync(src, resolve(licensesSubDir, fileName));
    }

    const rootDest = resolve(installDir, fileName);
    if (!hasLicensesSubDir || isFile(rootDest)) {
      copyFileSync(src, rootDest);
    }
  }
}

export async function startDesktopApp(targetExe) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(targetExe, [], {
      cwd: dirname(targetExe),
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.unref();
      resolvePromise({ pid: child.pid });
    }, 700);

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(new Error(`启动新版程序失败：${error.message}`));
    });

    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== null && code !== 0) {
        rejectPromise(new Error(`新版程序启动后立即退出（ExitCode=${code}）。`));
      } else {
        resolvePromise({ pid: child.pid });
      }
    });
  });
}

export async function replaceDesktopBinary({
  repoRoot,
  sourceExe,
  installDir,
  force = false,
  noLaunch = false,
  listPids = listRunningDesktopPids,
  stopProcesses = stopRunningDesktopProcesses,
  startApp = startDesktopApp,
  wait = sleep,
} = {}) {
  const targetExe = resolve(installDir, EXECUTABLE_NAME);
  if (resolve(dirname(targetExe)).toLowerCase() === resolve(dirname(sourceExe)).toLowerCase()) {
    throw new Error(`目标目录不能与编译产物目录相同：${installDir}`);
  }

  const sourceHash = await hashFileSha256(sourceExe);
  const targetHash = isFile(targetExe) ? await hashFileSha256(targetExe) : null;

  if (!force && targetHash && sourceHash === targetHash) {
    syncLicenseFiles({ repoRoot, installDir });
    logStep(`本地版本与当前 Release 产物一致（SHA256: ${sourceHash.slice(0, 12)}），无需替换。`);
    if (!noLaunch && listPids().length === 0) {
      logStep("启动 Cursor BYOK...");
      const started = await startApp(targetExe);
      logDetail(`已启动（PID: ${started.pid ?? "unknown"}）`);
    }
    return { status: "unchanged", sha256: sourceHash, targetExe };
  }

  const tempExe = `${targetExe}.new`;
  const backupExe = `${targetExe}.bak`;
  let wasRunning = false;
  let movedOriginalToBackup = false;

  logStep("暂存新版本可执行文件...");
  copyFileSync(sourceExe, tempExe);

  try {
    wasRunning = await stopProcesses();

    if (isFile(backupExe)) {
      await retryFileOperation(() => rmSync(backupExe, { force: true }), { wait });
    }
    if (isFile(targetExe)) {
      await retryFileOperation(() => renameSync(targetExe, backupExe), { wait });
      movedOriginalToBackup = true;
    }

    await retryFileOperation(() => renameSync(tempExe, targetExe), { wait });

    syncLicenseFiles({ repoRoot, installDir });
    logStep(`已替换为最新版本（SHA256: ${sourceHash.slice(0, 12)}）`);
    logDetail(`目标路径：${targetExe}`);

    if (!noLaunch) {
      logStep("正在启动新版 Cursor BYOK...");
      const started = await startApp(targetExe);
      logDetail(`已启动（PID: ${started.pid ?? "unknown"}）`);
    }

    if (movedOriginalToBackup && isFile(backupExe)) {
      try {
        rmSync(backupExe, { force: true });
      } catch {
        // Ignore transient cleanup failure once replacement & startup succeeded.
      }
    }

    return { status: "replaced", sha256: sourceHash, targetExe, wasRunning };
  } catch (error) {
    if (movedOriginalToBackup && isFile(backupExe)) {
      console.warn(`[update-local] 替换或启动失败，正在回滚旧版本：${error.message}`);
      try {
        await stopProcesses();
      } catch {
        // Best-effort process stop during rollback.
      }
      if (isFile(targetExe)) {
        await retryFileOperation(() => rmSync(targetExe, { force: true }), { wait });
      }
      await retryFileOperation(() => renameSync(backupExe, targetExe), { wait });
      if (wasRunning && !noLaunch && isFile(targetExe)) {
        try {
          await startApp(targetExe);
        } catch {
          // Do not mask original replacement error if rollback relaunch also fails.
        }
      }
    }
    throw error;
  } finally {
    if (isFile(tempExe)) {
      try {
        rmSync(tempExe, { force: true });
      } catch {
        // Best-effort staging file cleanup.
      }
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "..");
  const installDir = resolveInstallDirectory({ explicitDir: options.targetDir });
  const sourceExe = resolve(repoRoot, "target", "release", EXECUTABLE_NAME);
  const frontendDistIndex = resolve(repoRoot, "apps", "desktop", "dist", "index.html");
  const targetExe = resolve(installDir, EXECUTABLE_NAME);

  logStep(`仓库目录：${repoRoot}`);
  logStep(`本地目标目录：${installDir}`);

  const buildPlan = inspectBuildRequirement({
    repoRoot,
    sourceExe,
    frontendDistIndex,
    force: options.force,
  });

  if (buildPlan.required) {
    logStep(`需要编译：${buildPlan.reason}`);
  } else {
    logStep(`跳过编译：${buildPlan.reason}`);
  }

  if (options.checkOnly) {
    const sourceExists = isFile(sourceExe);
    const targetExists = isFile(targetExe);
    if (buildPlan.required) {
      logDetail("替换状态：需先完成编译再对比替换");
    } else if (sourceExists && targetExists) {
      const srcHash = await hashFileSha256(sourceExe);
      const dstHash = await hashFileSha256(targetExe);
      if (srcHash === dstHash && !options.force) {
        logDetail(`替换状态：本地 ${basename(targetExe)} 与 Release 产物 SHA-256 一致（${srcHash.slice(0, 12)}），无需替换`);
      } else {
        logDetail(`替换状态：可执行直接替换（Release ${srcHash.slice(0, 12)} -> 本地 ${dstHash.slice(0, 12)}）`);
      }
    } else {
      logDetail(`替换状态：待复制新版本到 ${targetExe}`);
    }
    const runningPids = listRunningDesktopPids();
    logDetail(`运行状态：当前有 ${runningPids.length} 个 ${EXECUTABLE_NAME} 进程`);
    return;
  }

  if (buildPlan.required) {
    invokeDesktopReleaseBuild(repoRoot);
    if (!isFile(sourceExe)) {
      throw new Error(`编译完成但未找到预期产物：${sourceExe}`);
    }
  }

  await replaceDesktopBinary({
    repoRoot,
    sourceExe,
    installDir,
    force: options.force,
    noLaunch: options.noLaunch,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[update-local] 失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
