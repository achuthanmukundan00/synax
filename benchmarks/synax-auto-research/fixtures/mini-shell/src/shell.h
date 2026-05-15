#ifndef SHELL_H
#define SHELL_H

/**
 * Execute a parsed pipeline from the given input line.
 * This is the main entry point called from the REPL loop.
 */
void execute_command(const char *line);

/**
 * Run an external command via fork/execvp/waitpid.
 * Returns the exit status of the child, or -1 on fork error.
 */
int run_external(char **args);

#endif
