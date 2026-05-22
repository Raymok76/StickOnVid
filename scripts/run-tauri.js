const { spawnSync } = require("child_process");
const path = require("path");

const home = process.env.USERPROFILE || process.env.HOME || "";
const cargoBin = path.join(home, ".cargo", "bin");
const env = {
  ...process.env,
  PATH: `${cargoBin}${path.delimiter}${process.env.PATH || ""}`,
};

const result = spawnSync("npx", ["tauri", ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: true,
  env,
  cwd: path.join(__dirname, ".."),
});

process.exit(result.status ?? 1);
