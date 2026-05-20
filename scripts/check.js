const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = process.cwd();
const ignoreDirs = new Set(["node_modules", ".git", "database", "backups"]);

function walk(dir, acc = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (ignoreDirs.has(entry.name)) continue;
      walk(fullPath, acc);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".js")) {
      acc.push(fullPath);
    }
  }
  return acc;
}

const files = walk(root).sort();
if (files.length === 0) {
  console.log("No JavaScript files found.");
  process.exit(0);
}

let hasError = false;
for (const file of files) {
  const rel = path.relative(root, file) || file;
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "pipe", encoding: "utf8" });
  if (result.status === 0) {
    console.log(`OK  ${rel}`);
  } else {
    hasError = true;
    console.error(`ERR ${rel}`);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.stdout) process.stderr.write(result.stdout);
  }
}

if (hasError) {
  process.exit(1);
}

console.log(`Checked ${files.length} file(s).`);
