// Reproduce the client-modules manifest resolution for this package, so a
// missing or mis-shaped client entry is caught here instead of at Web startup.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkgPath = join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

console.log("name:", pkg.name);
console.log("dsh.client:", JSON.stringify(pkg.dsh?.client));

const decl = pkg.dsh?.client;
const platform = decl?.platform;
console.log("platform === 'web':", platform === "web");

const entry = pkg.exports?.["./client"];
const rel = typeof entry === "string" ? entry : entry?.default;
console.log('exports["./client"]:', rel);

const abs = resolve(root, rel ?? "");
const ok = existsSync(abs);
console.log("client entry exists:", ok);
if (ok) {
  const body = readFileSync(abs, "utf8");
  console.log("size:", body.length);
  console.log("has __ModuleLoader__.load:", body.includes("__ModuleLoader__.load"));
  console.log("registers id:", /id:\s*["']dsh-bilibili-retrieval["']/.test(body));
}

const problems = [];
if (platform !== "web") problems.push("dsh.client.platform must be 'web'");
if (rel === undefined) problems.push('package.json exports must map "./client"');
if (!ok) problems.push("the file the ./client export points at does not exist");
console.log("");
console.log(problems.length === 0 ? "MANIFEST OK" : "MANIFEST BROKEN: " + problems.join("; "));
process.exit(problems.length === 0 ? 0 : 1);
