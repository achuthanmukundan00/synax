/**
 * main.c — Mini-shell REPL loop.
 *
 * Reads lines from stdin and passes them to execute_command().
 * Suppresses the prompt when stdin is not a terminal (pipe mode).
 */
#include "shell.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(void) {
  char *line = NULL;
  size_t len = 0;
  int interactive = isatty(STDIN_FILENO);

  while (1) {
    if (interactive) {
      printf("mini-shell> ");
      fflush(stdout);
    }

    if (getline(&line, &len, stdin) == -1) {
      break; /* EOF */
    }

    /* Remove trailing newline */
    line[strcspn(line, "\n")] = '\0';

    if (strlen(line) == 0) {
      continue; /* skip empty lines */
    }

    execute_command(line);
  }

  free(line);
  return 0;
}
