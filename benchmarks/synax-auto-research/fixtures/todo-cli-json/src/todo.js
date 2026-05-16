/**
 * TodoList — Core task management module.
 *
 * Manages an in-memory list of todo items and provides formatted output.
 * The JSON output path in formatList() is the missing feature for this benchmark.
 */

class TodoList {
  constructor(items = []) {
    this.items = items;
    this.nextId = items.length > 0 ? Math.max(...items.map((i) => i.id)) + 1 : 1;
  }

  add(description) {
    const item = { id: this.nextId++, description, done: false };
    this.items.push(item);
    return item;
  }

  list() {
    return [...this.items];
  }

  done(id) {
    const item = this.items.find((i) => i.id === id);
    if (!item) {
      throw new Error(`Todo #${id} not found.`);
    }
    item.done = true;
    return item;
  }

  /**
   * Format the todo list for display.
   *
   * @param {object} options
   * @param {boolean} [options.json=false] — Output JSON instead of text.
   * @returns {string}
   */
  formatList(options = {}) {
    const { json } = options;

    if (json) {
      // ═══ MISSING FEATURE — IMPLEMENT JSON OUTPUT HERE ═══
      // The --json flag should produce a JSON array like:
      //   [{"id":1,"description":"Buy milk","done":false}]
      // Currently falls through to text output (broken).
      // ═══════════════════════════════════════════════════════
    }

    // Text output (existing, working)
    if (this.items.length === 0) {
      return 'No todos.';
    }

    const lines = this.items.map((item) => {
      const status = item.done ? '✓' : ' ';
      return `[${status}] #${item.id}: ${item.description}`;
    });
    return lines.join('\n');
  }
}

module.exports = { TodoList };
