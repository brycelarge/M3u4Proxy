/**
 * EPG Config Converter
 * 
 * This script automatically converts CommonJS config files to ES Module format
 * during the EPG sync process.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Convert a CommonJS config file to ES Module format
 * @param {string} content - The content of the config file
 * @returns {string} - The converted content
 */
export function convertConfigToESM(content) {
  // Skip if already in ES Module format
  if (content.includes('export default')) {
    return content;
  }

  // Replace require statements with import statements
  let result = content
    .replace(/const\s+axios\s*=\s*require\(['"]axios['"]\)/g, "import axios from 'axios'")
    .replace(/const\s+dayjs\s*=\s*require\(['"]dayjs['"]\)/g, "import dayjs from 'dayjs'")
    .replace(/const\s+utc\s*=\s*require\(['"]dayjs\/plugin\/utc['"]\)/g, "import utc from 'dayjs/plugin/utc.js'")
    .replace(/const\s+timezone\s*=\s*require\(['"]dayjs\/plugin\/timezone['"]\)/g, "import timezone from 'dayjs/plugin/timezone.js'")
    .replace(/const\s+customParseFormat\s*=\s*require\(['"]dayjs\/plugin\/customParseFormat['"]\)/g, "import customParseFormat from 'dayjs/plugin/customParseFormat.js'")
    .replace(/const\s+uniqBy\s*=\s*require\(['"]lodash\.uniqby['"]\)/g, "import uniqBy from 'lodash.uniqby'")
    .replace(/const\s+cheerio\s*=\s*require\(['"]cheerio['"]\)/g, "import cheerio from 'cheerio'")
    .replace(/const\s+iconv\s*=\s*require\(['"]iconv-lite['"]\)/g, "import iconv from 'iconv-lite'")
    .replace(/const\s+([a-zA-Z0-9_]+)\s*=\s*require\(['"](.*)['"]\)/g, "import $1 from '$2'");

  // Replace module.exports with export default
  result = result.replace(/module\.exports\s*=/g, "export default");

  return result;
}

/**
 * Process a config file and convert it to ES Module format if needed
 * @param {string} filePath - Path to the config file
 */
export function processConfigFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const convertedContent = convertConfigToESM(content);
    
    // Only write if changes were made
    if (content !== convertedContent) {
      fs.writeFileSync(filePath, convertedContent, 'utf8');
      console.log(`[EPG] Converted ${filePath} to ES Module format`);
    }
  } catch (error) {
    console.error(`[EPG] Error processing config file ${filePath}:`, error.message);
  }
}

/**
 * Process all config files in a directory
 * @param {string} directory - Directory containing config files
 */
export function processConfigDirectory(directory) {
  try {
    const files = fs.readdirSync(directory);
    
    for (const file of files) {
      const filePath = path.join(directory, file);
      const stat = fs.statSync(filePath);
      
      if (stat.isDirectory()) {
        processConfigDirectory(filePath);
      } else if (file.endsWith('.config.js')) {
        processConfigFile(filePath);
      }
    }
  } catch (error) {
    console.error(`[EPG] Error processing directory ${directory}:`, error.message);
  }
}
