#!/usr/bin/env node
/**
 * todo — A tiny CLI task tracker.
 *
 * Commands:
 *   todo add <description>     Add a new task
 *   todo list [--json]         List tasks (text or JSON)
 *   todo done <id>             Mark a task as done
 *
 * The --json flag on `list` is the missing feature for this benchmark.
 */

const { TodoList } = require('./todo');
const storage = require('./storage');

const args = process.argv.slice(2);
const command = args[0];

const todoList = new TodoList(storage.load());

switch (command) {
  case 'add': {
    const desc = args.slice(1).join(' ');
    if (!desc) {
      console.error('Usage: todo add <description>');
      process.exit(1);
    }
    todoList.add(desc);
    storage.save(todoList.list());
    console.log(`Added: ${desc}`);
    break;
  }

  case 'list': {
    const useJson = args.includes('--json');
    const output = todoList.formatList({ json: useJson });
    console.log(output);
    break;
  }

  case 'done': {
    const id = parseInt(args[1], 10);
    if (isNaN(id)) {
      console.error('Usage: todo done <id>');
      process.exit(1);
    }
    try {
      todoList.done(id);
      storage.save(todoList.list());
      console.log(`Marked #${id} as done.`);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    break;
  }

  default:
    console.error('Usage: todo <add|list|done> [options]');
    process.exit(1);
}
