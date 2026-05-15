#ifndef PARSER_H
#define PARSER_H

/**
 * A single command in a pipeline stage.
 * `args`    — NULL-terminated array of argument strings.
 * `redirect_out`   — non-NULL if `>` is present; contains output filename.
 * `redirect_append` — non-NULL if `>>` is present; contains output filename.
 */
typedef struct {
  char **args;
  char *redirect_out;
  char *redirect_append;
} Command;

/**
 * A pipeline: one or more commands connected by `|`.
 * `commands` — NULL-terminated array of Command pointers (length >= 1).
 */
typedef struct {
  Command **commands;
} Pipeline;

/**
 * Parse an input line into a Pipeline.
 * Returns NULL if the line is empty or contains only whitespace.
 * Caller must call free_pipeline() to release memory.
 */
Pipeline *parse_line(const char *line);

/**
 * Free all memory allocated by parse_line().
 */
void free_pipeline(Pipeline *p);

#endif
