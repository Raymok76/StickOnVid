/**
 * Regenerate src-tauri/icons from logo01.ico (project root).
 * Windows taskbar icon is baked into the .exe at compile time — restart `npm run dev` after this.
 */
const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const root = path.join(__dirname, "..");
const logo = path.join(root, "logo01.ico");
const pyScript = path.join(__dirname, "generate-icons.py");

if (!fs.existsSync(logo)) {
  console.error("Missing logo01.ico in project root.");
  process.exit(1);
}

const r = spawnSync(
  "uv",
  ["run", "--with", "pillow", "python", pyScript],
  { stdio: "inherit", cwd: root, shell: true }
);
process.exit(r.status ?? 1);
