// Preload script to set up NODE_PATH for epg-grabber config files
// This must be CommonJS since it's loaded via --require

const path = require('node:path');
const Module = require('node:module');

// Add /app/node_modules to module search paths
const nodePath = path.join(process.cwd(), 'node_modules');

// Update Module._nodeModulePaths to include our path
const originalNodeModulePaths = Module._nodeModulePaths;
Module._nodeModulePaths = function(from) {
  const paths = originalNodeModulePaths.call(this, from);
  if (!paths.includes(nodePath)) {
    paths.unshift(nodePath);
  }
  return paths;
};

// Also add to global module paths
if (module.paths && !module.paths.includes(nodePath)) {
  module.paths.unshift(nodePath);
}
