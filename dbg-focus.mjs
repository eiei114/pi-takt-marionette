// Debug: single-session focus entry + typing.
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register from "./extensions/index.ts";

const root = mkdtempSync(join(tmpdir(), "dbg5-"));
const projectA = join(root, "proj");
mkdirSync(projectA, { recursive: true });
const logDir = join(root, "logs");
mkdirSync(logDir);

const nodeScript = join(root, "fake-takt.mjs");
const scriptLines = [
  'import { appendFileSync } from "node:fs";',
  'import { join as pjoin, basename } from "node:path";',
  "const dir = process.env.TEST_TAKT_LOG_DIR;",
  "const logPath = pjoin(dir, `${basename(process.cwd())}.log`);",
  "const args = process.argv.slice(2);",
  'const operation = args.at(-1) === "resume" ? "resume" : args[0];',
  "const event = (value) => appendFileSync(logPath, `${value}\\n`);",
  'if (operation === "list") {',
  '  process.stdout.write(JSON.stringify({ tasks: [] }) + "\\n");',
  "  process.exit(0);",
  '} else if (operation === "clear") {',
  '  event("clear");',
  "  process.exit(0);",
  '} else if (operation === "resume") {',
  '  setInterval(() => {}, 1000);',
  '} else if (operation === "run") {',
  '  event("run-start");',
  '  process.stdout.write("Assistant>\\r\\n");',
  '  process.stdin.setEncoding("utf8");',
  '  process.stdin.on("data", (data) => {',
  '    if (data.includes("quit-now")) { event("run-exit"); process.exit(0); }',
  "    event(`in:${JSON.stringify(data)}`);",
  "  });",
  "  setInterval(() => {}, 1000);",
  "} else {",
  "  process.exit(2);",
  "}",
];
writeFileSync(nodeScript, scriptLines.join("\n"), "utf8");

const quote = (value) => `"${value.replaceAll('"', '\\"')}"`;
const command = join(root, "fake-takt.cmd");
writeFileSync(command, `@echo off\r\n@${quote(process.execPath)} ${quote(nodeScript)} %*\r\n`, "utf8");

process.env.TAKT_CONFIG_DIR = root;
process.env.APPDATA = root;
process.env.XDG_CONFIG_HOME = root;
process.env.TAKT_COMMAND = command;
process.env.TEST_TAKT_LOG_DIR = logDir;

const bridgeDir = join(root, "pi-takt-bridge");
mkdirSync(bridgeDir, { recursive: true });
writeFileSync(
  join(bridgeDir, "profiles.json"),
  JSON.stringify({ version: 1, profiles: [{ name: "alpha", cwd: projectA, preset: "default" }] }),
  "utf8",
);

const tools = new Map();
const commands = new Map();
const events = new Map();
register({
  registerTool: (tool) => tools.set(tool.name, tool),
  on: (name, handler) => events.set(name, handler),
  registerCommand: (name, definition) => commands.set(name, definition),
  registerShortcut() {},
});

let activeCustom = null;
const notifications = [];
const context = {
  cwd: projectA,
  mode: "tui",
  hasUI: true,
  ui: {
    notify(message, type) {
      notifications.push(`${type}: ${message}`);
      console.log(`NOTIFY[${type}]:`, message);
    },
    setStatus() {},
    setWidget() {},
    onTerminalInput: () => () => {},
    select: async (_t, c) => c[0],
    confirm: async () => true,
    input: async () => undefined,
    editor: async () => "",
    custom(factory, options) {
      return new Promise((resolve) => {
        const done = (value) => {
          console.log("--- custom done() called");
          activeCustom = null;
          resolve(value);
        };
        const component = factory(
          { requestRender() {}, terminal: { rows: 30, columns: 120 } },
          { fg: (_c, s) => s },
          {},
          done,
        );
        activeCustom = { component, done, options };
        console.log("--- custom opened, render:");
        console.log(component.render(120, 30).slice(0, 4).join("\n"));
      });
    },
  },
};

await events.get("session_start")({ reason: "startup" }, context);
await commands.get("takt:start").handler("alpha", context);
await new Promise((resolve) => setTimeout(resolve, 1200));

console.log("--- takt:mode takt");
await commands.get("takt:mode").handler("takt", context);
await new Promise((resolve) => setTimeout(resolve, 300));
console.log("activeCustom?", activeCustom !== null);
if (activeCustom) {
  console.log("--- typing direct\\r");
  activeCustom.component.handleInput("direct\r");
  await new Promise((resolve) => setTimeout(resolve, 600));
}
const logPath = join(logDir, "proj.log");
console.log("proj.log:", existsSync(logPath) ? readFileSync(logPath, "utf8") : "(none)");
await events.get("session_shutdown")?.({ reason: "test" }, context);
process.exit(0);
