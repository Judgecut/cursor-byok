import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  inspectBuildRequirement,
  parseArgs,
  parseRegistryInstallDirs,
  parseTasklistCsv,
  replaceDesktopBinary,
  resolveInstallDirectory,
  stopRunningDesktopProcesses,
} from "./update-local-desktop.mjs";

function makeTempWorkspace(t) {
  const root = mkdtempSync(resolve(tmpdir(), "cursor-byok-update-test-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function writeTimedFile(filePath, content, secondsOffset) {
  mkdirSync(resolve(filePath, ".."), { recursive: true });
  writeFileSync(filePath, content);
  const time = new Date(1_760_000_000_000 + secondsOffset * 1000);
  utimesSync(filePath, time, time);
}

test("parseArgs supports GNU and PowerShell style switches", () => {
  assert.deepEqual(parseArgs(["-CheckOnly", "-NoLaunch", "-TargetDir", "D:\\Apps\\Cursor"]), {
    targetDir: "D:\\Apps\\Cursor",
    force: false,
    noLaunch: true,
    checkOnly: true,
    help: false,
  });

  assert.deepEqual(parseArgs(["--force", "--target-dir=C:\\Cursor"]), {
    targetDir: "C:\\Cursor",
    force: true,
    noLaunch: false,
    checkOnly: false,
    help: false,
  });
});

test("parseRegistryInstallDirs extracts quoted and unquoted install locations", () => {
  const regOutput = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Cursor BYOK
    DisplayName    REG_SZ    Cursor BYOK
    InstallLocation    REG_SZ    "C:\\Users\\Alice\\AppData\\Local\\Cursor BYOK"
    UninstallString    REG_SZ    C:\\Portable\\Cursor BYOK\\uninstall.exe /S
`;
  assert.deepEqual(parseRegistryInstallDirs(regOutput), [
    "C:\\Users\\Alice\\AppData\\Local\\Cursor BYOK",
    "C:\\Portable\\Cursor BYOK",
  ]);
});

test("resolveInstallDirectory prefers candidate containing desktop executable", (t) => {
  const root = makeTempWorkspace(t);
  const emptyInstall = resolve(root, "EmptyDir");
  const realInstall = resolve(root, "RealDir");
  mkdirSync(emptyInstall, { recursive: true });
  mkdirSync(realInstall, { recursive: true });
  writeFileSync(resolve(realInstall, "cursor-byok-desktop.exe"), "exe");

  const resolved = resolveInstallDirectory({
    queryRegistry: () => [
      `InstallLocation    REG_SZ    "${emptyInstall}"`,
      `UninstallString    REG_SZ    "${resolve(realInstall, "uninstall.exe")}"`,
    ],
    env: {},
  });

  assert.equal(resolved, realInstall);
});

test("inspectBuildRequirement detects missing, stale frontend dist, stale source, and up-to-date state", (t) => {
  const root = makeTempWorkspace(t);
  const distIndex = resolve(root, "apps/desktop/dist/index.html");
  const releaseExe = resolve(root, "target/release/cursor-byok-desktop.exe");
  const frontendSrc = resolve(root, "apps/desktop/src/main.tsx");
  const rustSrc = resolve(root, "server/src/lib.rs");

  assert.equal(inspectBuildRequirement({ repoRoot: root }).required, true);

  writeTimedFile(frontendSrc, "console.log(1);", 10);
  writeTimedFile(rustSrc, "pub fn ok() {}", 10);
  writeTimedFile(distIndex, "<html></html>", 20);
  writeTimedFile(releaseExe, "binary", 30);

  assert.equal(inspectBuildRequirement({ repoRoot: root }).required, false);

  writeTimedFile(frontendSrc, "console.log(2);", 40);
  writeTimedFile(releaseExe, "binary-stale-frontend", 50);
  const staleFrontend = inspectBuildRequirement({ repoRoot: root });
  assert.equal(staleFrontend.required, true);
  assert.match(staleFrontend.reason, /前端源码/);

  writeTimedFile(distIndex, "<html>v2</html>", 60);
  const newerDist = inspectBuildRequirement({ repoRoot: root });
  assert.equal(newerDist.required, true);
  assert.match(newerDist.reason, /前端 dist/);

  writeTimedFile(releaseExe, "binary-fresh", 70);
  assert.equal(inspectBuildRequirement({ repoRoot: root }).required, false);

  writeTimedFile(rustSrc, "pub fn changed() {}", 80);
  const staleRust = inspectBuildRequirement({ repoRoot: root });
  assert.equal(staleRust.required, true);
  assert.match(staleRust.reason, /server\/src\/lib\.rs/);
});

test("parseTasklistCsv parses matching desktop PIDs safely across locales", () => {
  const none = "INFO: No tasks are running which match the specified criteria.\n";
  assert.deepEqual(parseTasklistCsv(none), []);

  const running = `"cursor-byok-desktop.exe","12456","Console","1","85,200 K"\r\n"other.exe","99","Console","1","10 K"\r\n`;
  assert.deepEqual(parseTasklistCsv(running), [12456]);
});

test("stopRunningDesktopProcesses stops active processes and waits for exit", async () => {
  let checks = 0;
  let killed = false;
  const wasRunning = await stopRunningDesktopProcesses({
    listPids: () => {
      checks += 1;
      return checks <= 2 ? [4321] : [];
    },
    killAll: () => {
      killed = true;
    },
    wait: async () => {},
    timeoutMs: 1000,
  });

  assert.equal(killed, true);
  assert.equal(wasRunning, true);
});

test("replaceDesktopBinary skips copy on matching hash, updates changed exe + licenses, and rolls back on launch error", async (t) => {
  const root = makeTempWorkspace(t);
  const sourceDir = resolve(root, "target/release");
  const installDir = resolve(root, "installed");
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(resolve(installDir, "licenses"), { recursive: true });

  writeFileSync(resolve(root, "LICENSE"), "MIT v2");
  writeFileSync(resolve(root, "THIRD-PARTY-LICENSES.md"), "NOTICE v2");

  const sourceExe = resolve(sourceDir, "cursor-byok-desktop.exe");
  const targetExe = resolve(installDir, "cursor-byok-desktop.exe");
  writeFileSync(sourceExe, "build-v1");
  writeFileSync(targetExe, "build-v1");

  const unchanged = await replaceDesktopBinary({
    repoRoot: root,
    sourceExe,
    installDir,
    noLaunch: true,
    listPids: () => [],
    wait: async () => {},
  });
  assert.equal(unchanged.status, "unchanged");
  assert.equal(readFileSync(resolve(installDir, "licenses/LICENSE"), "utf8"), "MIT v2");
  assert.equal(existsSync(resolve(installDir, "LICENSE")), false);

  writeFileSync(sourceExe, "build-v2");
  const replaced = await replaceDesktopBinary({
    repoRoot: root,
    sourceExe,
    installDir,
    noLaunch: true,
    stopProcesses: async () => true,
    wait: async () => {},
  });
  assert.equal(replaced.status, "replaced");
  assert.equal(readFileSync(targetExe, "utf8"), "build-v2");
  assert.equal(readFileSync(resolve(installDir, "licenses/THIRD-PARTY-LICENSES.md"), "utf8"), "NOTICE v2");

  writeFileSync(sourceExe, "build-v3-bad");
  let relaunchedExe = null;
  await assert.rejects(
    () =>
      replaceDesktopBinary({
        repoRoot: root,
        sourceExe,
        installDir,
        noLaunch: false,
        stopProcesses: async () => true,
        startApp: async (exePath) => {
          if (readFileSync(exePath, "utf8") === "build-v3-bad") {
            throw new Error("boom");
          }
          relaunchedExe = exePath;
          return { pid: 999 };
        },
        wait: async () => {},
      }),
    /boom/,
  );

  assert.equal(readFileSync(targetExe, "utf8"), "build-v2");
  assert.equal(relaunchedExe, targetExe);
});
