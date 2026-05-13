CC = cc
CFLAGS = -Wall -Wextra -std=c99 -pedantic -g

OBJS = src/main.o src/shell.o src/parser.o

.PHONY: all clean test

all: mini-shell

mini-shell: $(OBJS)
	$(CC) $(CFLAGS) -o $@ $^

src/main.o: src/main.c src/shell.h
	$(CC) $(CFLAGS) -c -o $@ $<

src/shell.o: src/shell.c src/shell.h src/parser.h
	$(CC) $(CFLAGS) -c -o $@ $<

src/parser.o: src/parser.c src/parser.h
	$(CC) $(CFLAGS) -c -o $@ $<

test: all
	cd test && sh run-tests.sh

clean:
	rm -f mini-shell src/*.o
