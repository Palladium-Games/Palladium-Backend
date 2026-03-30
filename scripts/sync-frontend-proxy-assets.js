#!/usr/bin/env node

const cp = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const BACKEND_DIR = path.resolve(__dirname, "..");
const RUNTIME_PACKAGE_NAMES = [
  "@mercuryworkshop/scramjet",
  "@mercuryworkshop/bare-mux",
  "@mercuryworkshop/libcurl-transport"
];
const ASSET_TARGETS = [
  {
    sourcePath: path.join("node_modules", "@mercuryworkshop", "scramjet", "dist", "scramjet.all.js"),
    targetPath: path.join("scram", "scramjet.all.js")
  },
  {
    sourcePath: path.join("node_modules", "@mercuryworkshop", "scramjet", "dist", "scramjet.sync.js"),
    targetPath: path.join("scram", "scramjet.sync.js")
  },
  {
    sourcePath: path.join("node_modules", "@mercuryworkshop", "scramjet", "dist", "scramjet.wasm.wasm"),
    targetPath: path.join("scram", "scramjet.wasm.wasm")
  },
  {
    sourcePath: path.join("node_modules", "@mercuryworkshop", "bare-mux", "dist", "index.js"),
    targetPath: path.join("baremux", "index.js")
  },
  {
    sourcePath: path.join("node_modules", "@mercuryworkshop", "bare-mux", "dist", "worker.js"),
    targetPath: path.join("baremux", "worker.js")
  },
  {
    sourcePath: path.join("node_modules", "@mercuryworkshop", "libcurl-transport", "dist", "index.mjs"),
    targetPath: path.join("libcurl", "index.mjs")
  }
];

function resolveFrontendDir(baseDir = BACKEND_DIR) {
  const candidates = [
    path.resolve(baseDir, "..", "Antarctic-Games"),
    path.resolve(baseDir, "..", "Antarctic-Frontend"),
    path.resolve(baseDir, "..", "antarctic-frontend"),
    path.resolve(baseDir, "..", "palladium-frontend"),
    path.resolve(baseDir, "..", "frontend")
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "index.html"))) {
      return candidate;
    }
  }

  throw new Error(
    "Could not find a sibling frontend checkout. Expected index.html under ../Antarctic-Games, ../Antarctic-Frontend, ../antarctic-frontend, ../palladium-frontend, or ../frontend."
  );
}

function readBackendPackageJson(backendDir = BACKEND_DIR) {
  const packageJsonPath = path.join(path.resolve(backendDir), "package.json");
  return JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
}

function getProxyRuntimePackageSpecs(backendDir = BACKEND_DIR) {
  const packageJson = readBackendPackageJson(backendDir);
  const dependencies = packageJson && packageJson.dependencies ? packageJson.dependencies : {};
  return RUNTIME_PACKAGE_NAMES.map((name) => {
    const spec = String(dependencies[name] || "").trim();
    if (!spec) {
      throw new Error(`Missing ${name} in ${path.join(path.resolve(backendDir), "package.json")}.`);
    }

    return {
      name,
      spec
    };
  });
}

function resolveAssetPairs(options = {}) {
  const backendDir = path.resolve(options.backendDir || BACKEND_DIR);
  const frontendDir = path.resolve(options.frontendDir || resolveFrontendDir(backendDir));
  return ASSET_TARGETS.map((target) => ({
    sourcePath: path.join(backendDir, target.sourcePath),
    targetPath: path.join(frontendDir, target.targetPath),
    relativeTargetPath: target.targetPath
  }));
}

function getProxyAssetRoots(frontendDir) {
  return [
    path.join(frontendDir, "scram"),
    path.join(frontendDir, "baremux"),
    path.join(frontendDir, "libcurl")
  ];
}

async function ensureSourceAssetsExist(assetPairs, backendDir) {
  for (const asset of assetPairs) {
    if (!fs.existsSync(asset.sourcePath)) {
      throw new Error(
        `Missing proxy asset ${asset.sourcePath}. Run npm install in ${backendDir} before syncing frontend proxy assets.`
      );
    }
  }
}

async function wipeFrontendProxyAssets(frontendDir) {
  const roots = getProxyAssetRoots(frontendDir);
  for (const root of roots) {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

function getBackendProxyPackageDirs(backendDir, packageSpecs) {
  return packageSpecs.map((entry) =>
    path.join(path.resolve(backendDir), "node_modules", ...String(entry.name || "").split("/"))
  );
}

function getProxyRuntimeNpmCacheDir(backendDir) {
  return path.join(path.resolve(backendDir), ".npm-cache");
}

function runInstallCommand(backendDir, command, args, env) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, args, {
      cwd: backendDir,
      env: env,
      stdio: "inherit"
    });

    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}.`));
    });
  });
}

async function reinstallBackendProxyPackages(options = {}) {
  const backendDir = path.resolve(options.backendDir || BACKEND_DIR);
  const packageSpecs = Array.isArray(options.packageSpecs) && options.packageSpecs.length
    ? options.packageSpecs.map((entry) => ({
        name: String(entry.name || "").trim(),
        spec: String(entry.spec || "").trim()
      }))
    : getProxyRuntimePackageSpecs(backendDir);
  const runInstall = typeof options.runInstall === "function"
    ? options.runInstall
    : function defaultRunInstall(context) {
        return runInstallCommand(context.backendDir, context.command, context.args, context.env);
      };
  const command = String(options.npmCommand || "npm").trim() || "npm";
  const npmCacheDir = path.resolve(options.npmCacheDir || getProxyRuntimeNpmCacheDir(backendDir));

  for (const packageDir of getBackendProxyPackageDirs(backendDir, packageSpecs)) {
    await fsp.rm(packageDir, { recursive: true, force: true });
  }

  const args = ["install", "--no-save"].concat(
    packageSpecs.map((entry) => `${entry.name}@${entry.spec}`)
  );
  const env = Object.assign({}, process.env, {
    npm_config_cache: npmCacheDir
  });

  await runInstall({
    backendDir,
    command,
    args,
    env,
    packageSpecs
  });

  return {
    backendDir,
    command,
    args,
    env,
    npmCacheDir,
    packageSpecs
  };
}

async function getMismatchedProxyAssets(assetPairs) {
  const mismatches = [];

  for (const asset of assetPairs) {
    const sourceBuffer = await fsp.readFile(asset.sourcePath);
    let targetBuffer = null;
    try {
      targetBuffer = await fsp.readFile(asset.targetPath);
    } catch {
      mismatches.push(`${asset.relativeTargetPath} (missing)`);
      continue;
    }

    if (!sourceBuffer.equals(targetBuffer)) {
      mismatches.push(asset.relativeTargetPath);
    }
  }

  return mismatches;
}

async function syncFrontendProxyAssets(options = {}) {
  const backendDir = path.resolve(options.backendDir || BACKEND_DIR);
  const frontendDir = path.resolve(options.frontendDir || resolveFrontendDir(backendDir));
  const clean = Boolean(options.clean);
  const check = Boolean(options.check);
  const reinstall = Boolean(options.reinstall);
  const assetPairs = resolveAssetPairs({ backendDir, frontendDir });

  if (reinstall) {
    await reinstallBackendProxyPackages({
      backendDir,
      npmCommand: options.npmCommand,
      packageSpecs: options.packageSpecs,
      runInstall: options.runInstall
    });
  }

  await ensureSourceAssetsExist(assetPairs, backendDir);

  if (check) {
    const mismatches = await getMismatchedProxyAssets(assetPairs);
    if (mismatches.length) {
      throw new Error(
        `Frontend proxy assets are out of sync: ${mismatches.join(", ")}. Run npm run refresh:frontend-proxy in ${backendDir}.`
      );
    }

    return {
      backendDir,
      frontendDir,
      count: assetPairs.length,
      verified: true
    };
  }

  if (clean) {
    await wipeFrontendProxyAssets(frontendDir);
  }

  for (const asset of assetPairs) {
    await fsp.mkdir(path.dirname(asset.targetPath), { recursive: true });
    await fsp.copyFile(asset.sourcePath, asset.targetPath);
  }

  return {
    backendDir,
    frontendDir,
    count: assetPairs.length,
    cleaned: clean,
    reinstalled: reinstall
  };
}

function parseArgs(argv) {
  return {
    check: argv.includes("--check"),
    clean: argv.includes("--clean"),
    reinstall: argv.includes("--reinstall")
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await syncFrontendProxyAssets(options);
  if (options.check) {
    console.log("Verified %d Scramjet proxy assets in %s", result.count, result.frontendDir);
    return;
  }

  console.log(
    "%s %d Scramjet proxy assets into %s",
    result.reinstalled ? "Reinstalled and refreshed" : result.cleaned ? "Refreshed" : "Synced",
    result.count,
    result.frontendDir
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  ASSET_TARGETS,
  BACKEND_DIR,
  getMismatchedProxyAssets,
  getProxyRuntimePackageSpecs,
  getProxyRuntimeNpmCacheDir,
  reinstallBackendProxyPackages,
  resolveAssetPairs,
  resolveFrontendDir,
  syncFrontendProxyAssets,
  wipeFrontendProxyAssets
};
