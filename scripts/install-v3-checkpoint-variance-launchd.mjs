import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";

const label = "sg.crossborder.v3-checkpoint-variance";
const home = homedir();
const repo = "/Users/cheewee/Documents/CrossBorder.sg";
const launchAgents = join(home, "Library", "LaunchAgents");
const support = join(home, "Library", "Application Support", "CrossBorder.sg");
const plistPath = join(launchAgents, `${label}.plist`);
const runnerSourcePath = join(repo, "scripts", "run-v3-checkpoint-variance.sh");
const runnerPath = join(support, "run-v3-checkpoint-variance.sh");
const domain = `gui/${process.getuid()}`;

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>/bin/zsh</string><string>${runnerPath}</string></array>
  <key>StartInterval</key><integer>3600</integer>
  <key>StandardOutPath</key><string>${support}/logs/v3-checkpoint-variance.out.log</string>
  <key>StandardErrorPath</key><string>${support}/logs/v3-checkpoint-variance.err.log</string>
</dict></plist>\n`;

function run(command, args) {
  return new Promise((resolve, reject) => execFile(command, args, (error, stdout, stderr) => (
    error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr })
  )));
}

await mkdir(launchAgents, { recursive: true });
await mkdir(join(support, "logs"), { recursive: true });
await writeFile(runnerPath, await readFile(runnerSourcePath, "utf8"));
await chmod(runnerPath, 0o755);
await writeFile(plistPath, plist);
await run("launchctl", ["bootout", domain, plistPath]).catch(() => undefined);
await run("launchctl", ["bootstrap", domain, plistPath]);
console.log(`Installed ${label}; it runs now and then hourly.`);
