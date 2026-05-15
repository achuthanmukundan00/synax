/**
 * shell.c — Command execution.
 *
 * Already working:
 *   - Simple external commands via fork/execvp/waitpid
 *   - The `exit` builtin (supports numeric exit code)
 *
 * Missing (Synax must implement):
 *   - `cd <dir>` builtin   (chdir)
 *   - `pwd` builtin        (getcwd)
 *   - Redirection          (> and >>, via dup2/open)
 *   - Pipelines            (|, via pipe/dup2/fork)
 *
 * The parser (parser.c) needs corresponding changes to fill in
 * redirect_out, redirect_append, and the commands array for pipelines.
 */
#include "shell.h"
#include "parser.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/wait.h>

/* ── public API ─────────────────────────────────────────── */

void execute_command(const char *line) {
  Pipeline *p = parse_line(line);
  if (!p || !p->commands || !p->commands[0]) {
    free_pipeline(p);
    return;
  }

  Command *cmd = p->commands[0]; /* only first command for now */

  if (!cmd->args || !cmd->args[0]) {
    free_pipeline(p);
    return;
  }

  /* ── builtins ────────────────────────────────────────── */

  if (strcmp(cmd->args[0], "exit") == 0) {
    int code = 0;
    if (cmd->args[1]) {
      code = atoi(cmd->args[1]);
    }
    free_pipeline(p);
    exit(code);
  }

  /* TODO: cd <dir> */
  /* TODO: pwd          */

  /* ── external command ────────────────────────────────── */

  /* TODO: stdout redirection (redirect_out / redirect_append) */
  /* TODO: pipeline stages                                    */

  run_external(cmd->args);

  free_pipeline(p);
}

int run_external(char **args) {
  pid_t pid = fork();
  if (pid < 0) {
    perror("mini-shell: fork");
    return -1;
  }
  if (pid == 0) {
    /* child */
    execvp(args[0], args);
    perror("mini-shell: execvp");
    _exit(127);
  }
  /* parent */
  int status;
  waitpid(pid, &status, 0);
  return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
}
