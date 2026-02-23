#!/usr/bin/env node
// Wrapper script to run epg-grabber with proper NODE_PATH for config files

const path = require('node:path');
const Module = require('node:module');

// Add /app/node_modules to module resolution paths
const nodePath = path.join(process.cwd(), 'node_modules');

// Monkey-patch Module._nodeModulePaths to include our node_modules
const originalNodeModulePaths = Module._nodeModulePaths;
Module._nodeModulePaths = function(from) {
  const paths = originalNodeModulePaths.call(this, from);
  if (!paths.includes(nodePath)) {
    paths.unshift(nodePath);
  }
  return paths;
};

// Now import and run epg-grabber
const epgGrabberPath = path.join(process.cwd(), 'node_modules', 'epg-grabber', 'dist', 'index.js');
import(epgGrabberPath).catch(err => {
  console.error('Failed to load epg-grabber:', err);
  process.exit(1);
});
