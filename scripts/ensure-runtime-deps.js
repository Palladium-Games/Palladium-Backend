#!/usr/bin/env node

const path = require("node:path");
const { execFileSync } = require("node:child_process");

/**
 * Runtime-only module specifiers that must resolve before the backend can boot.
 *
 * @type {readonly string[]}
 */
const REQUIRED_RUNTIME_MODULES = Object.freeze([
  "@mercuryworkshop/wisp-js/server",
  "@mercuryworkshop/bare-mux",
  "@mercuryworkshop/libcurl-transport",
  "@mercuryworkshop/scramjet",
  "sql.js",
  "ws"
]);

/**
 * Resolves a module specifier from the backend root.
 *
 * @param {string} rootDir - Absolute backend root directory.
 * @param {string} specifier - Module specifier to resolve.
 * @returns {string} Absolute resolved path.
 */
function resolveRuntimeModule(rootDir, specifier) {
  return require.resolve(specifier, { paths: [rootDir] });
}

/**
 * Finds runtime modules that are missing from the current install.
 *
 * @param {string} rootDir - Absolute backend root directory.
 * @param {readonly string[]} [specifiers=REQUIRED_RUNTIME_MODULES] - Modules that must resolve.
 * @param {(rootDir: string, specifier: string) => string} [resolver=resolveRuntimeModule] - Resolver used for testable module discovery.
 * @returns {string[]} Missing module specifiers.
 */
function getMissingRuntimeModules(rootDir, specifiers = REQUIRED_RUNTIME_MODULES, resolver = resolveRuntimeModule) {
  return specifiers.filter((specifier) => {
    try {
      resolver(rootDir, specifier);
      return false;
    } catch {
      return true;
    }
  });
}

/**
 * Installs production runtime dependencies for the backend.
 *
 * @param {string} rootDir - Absolute backend root directory.
 */
function installRuntimeDependencies(rootDir) {
  execFileSync("npm", ["ci", "--omit=dev"], {
    cwd: rootDir,
    stdio: "inherit"
  });
}

/**
 * Ensures runtime dependencies exist before the backend process starts.
 *
 * @param {string} rootDir - Absolute backend root directory.
 * @param {object} [options] - Injectable hooks used by tests.
 * @param {(rootDir: string, specifier: string) => string} [options.resolver=resolveRuntimeModule] - Resolver used to validate installed modules.
 * @param {(rootDir: string) => void} [options.installer=installRuntimeDependencies] - Installer invoked when dependencies are missing.
 * @param {{ log: (message: string) => void }} [options.logger=console] - Logger used for bootstrap status output.
 * @returns {{ installed: boolean, missing: string[] }} Whether installation happened and which modules triggered it.
 * @throws {Error} When required modules still cannot be resolved after installation.
 */
function ensureRuntimeDependencies(
  rootDir,
  {
    resolver = resolveRuntimeModule,
    installer = installRuntimeDependencies,
    logger = console
  } = {}
) {
  const missing = getMissingRuntimeModules(rootDir, REQUIRED_RUNTIME_MODULES, resolver);
  if (missing.length === 0) {
    return { installed: false, missing: [] };
  }

  logger.log(`Installing backend runtime dependencies: ${missing.join(", ")}`);
  installer(rootDir);

  const remaining = getMissingRuntimeModules(rootDir, REQUIRED_RUNTIME_MODULES, resolver);
  if (remaining.length > 0) {
    throw new Error(`Runtime dependencies are still missing after install: ${remaining.join(", ")}`);
  }

  return { installed: true, missing };
}

if (require.main === module) {
  const backendRoot = path.resolve(__dirname, "..");
  ensureRuntimeDependencies(backendRoot);
}

module.exports = {
  REQUIRED_RUNTIME_MODULES,
  ensureRuntimeDependencies,
  getMissingRuntimeModules,
  installRuntimeDependencies,
  resolveRuntimeModule
};
