CC ?= cc
CFLAGS ?= -g -O0 -Wall -Wextra
BUILD ?= build

all: $(BUILD)/stdio-echo

$(BUILD)/stdio-echo: src/main.c | $(BUILD)
	$(CC) $(CFLAGS) -o $@ $^

$(BUILD):
	mkdir -p $@

clean:
	rm -rf $(BUILD)

.PHONY: all clean
