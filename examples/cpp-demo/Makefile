CXX ?= g++
CXXFLAGS ?= -g -O0 -Wall -Wextra -pthread
BUILD ?= build

all: $(BUILD)/cpp-demo

$(BUILD)/cpp-demo: src/main.cpp | $(BUILD)
	$(CXX) $(CXXFLAGS) -o $@ $^

$(BUILD):
	mkdir -p $@

clean:
	rm -rf $(BUILD)

.PHONY: all clean
