import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const distDir = new URL("../dist/", import.meta.url);
const swPath = new URL("sw.js", distDir);

const urls = await collectDistUrls(distDir);
const buildHash = await createBuildHash(urls);
const swSource = await readFile(swPath, "utf8");

const nextSource = swSource
  .replace(/const CACHE_NAME = "visual-timer-[^"]+";/, `const CACHE_NAME = "visual-timer-${buildHash}";`)
  .replace(
    /const PRECACHE_URLS = \[[\s\S]*?\];/,
    `const PRECACHE_URLS = ${JSON.stringify(urls, null, 2)};`
  );

await writeFile(swPath, nextSource);

async function collectDistUrls(rootUrl) {
  const rootPath = rootUrl.pathname;
  const filePaths = await walk(rootUrl);
  const urls = new Set(["/"]);

  for (const filePath of filePaths) {
    const url = `/${relative(rootPath, filePath).split(sep).join("/")}`;
    if (url !== "/sw.js") {
      urls.add(url);
    }
  }

  return [...urls].sort((a, b) => {
    if (a === "/") return -1;
    if (b === "/") return 1;
    if (a === "/index.html") return -1;
    if (b === "/index.html") return 1;
    return a.localeCompare(b);
  });
}

async function walk(dirUrl) {
  const entries = await readdir(dirUrl, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = join(dirUrl.pathname, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(new URL(`${entry.name}/`, dirUrl))));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

async function createBuildHash(urls) {
  const hash = createHash("sha256");

  for (const url of urls) {
    if (url === "/") {
      continue;
    }

    hash.update(url);
    hash.update(await readFile(new URL(`.${url}`, distDir)));
  }

  return hash.digest("hex").slice(0, 12);
}
