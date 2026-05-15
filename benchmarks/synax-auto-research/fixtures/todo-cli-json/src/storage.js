/**
 * Simple file-based persistence for todo items.
 *
 * Reads/writes a JSON array to data/todos.json.
 * Used by the CLI entrypoint to persist tasks between invocations.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'todos.json');

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (_err) {
    // Corrupt or missing file — start fresh
  }
  return [];
}

function save(items) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(items, null, 2), 'utf-8');
}

module.exports = { load, save };
