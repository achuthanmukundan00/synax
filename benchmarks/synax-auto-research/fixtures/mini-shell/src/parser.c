/**
 * parser.c — Input line tokenizer.
 *
 * STUB — currently only splits on whitespace.  Synax must extend this to
 * handle quoted strings, environment variable expansion, redirection
 * operators (> and >>), and the pipeline separator (|).
 *
 * The Pipeline / Command structs are defined in parser.h and already carry
 * slots for redirect_out and redirect_append.
 */
#include "parser.h"
#include <stdlib.h>
#include <string.h>

Pipeline *parse_line(const char *line) {
  if (!line || !*line) {
    return NULL;
  }

  /* Make a mutable copy for strtok */
  char *copy = strdup(line);
  if (!copy) return NULL;

  /* Count tokens and collect them */
  char *tokens[64];
  int count = 0;
  char *tok = strtok(copy, " \t");
  while (tok && count < 63) {
    tokens[count++] = tok;
    tok = strtok(NULL, " \t");
  }

  if (count == 0) {
    free(copy);
    return NULL;
  }

  /* ── STUB: no quote, env, redirect, or pipe handling yet ── */

  Pipeline *p = calloc(1, sizeof(Pipeline));
  p->commands = calloc(2, sizeof(Command *)); /* at most 1 command + NULL */

  Command *cmd = calloc(1, sizeof(Command));
  p->commands[0] = cmd;

  /* Copy tokens into cmd->args (owned by the pipeline now) */
  cmd->args = calloc((size_t)(count + 1), sizeof(char *));
  for (int i = 0; i < count; i++) {
    cmd->args[i] = strdup(tokens[i]);
  }
  cmd->args[count] = NULL;

  free(copy);
  return p;
}

void free_pipeline(Pipeline *p) {
  if (!p) return;
  if (p->commands) {
    for (int i = 0; p->commands[i]; i++) {
      Command *cmd = p->commands[i];
      if (cmd->args) {
        for (int j = 0; cmd->args[j]; j++) {
          free(cmd->args[j]);
        }
        free(cmd->args);
      }
      free(cmd->redirect_out);
      free(cmd->redirect_append);
      free(cmd);
    }
    free(p->commands);
  }
  free(p);
}
