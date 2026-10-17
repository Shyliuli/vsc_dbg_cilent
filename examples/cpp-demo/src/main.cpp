// Demo program for the debugger front end. It deliberately contains a loop,
// recursion, heap containers, pointers, threads and a C++ exception so that
// every debugging surface has something real to show.
#include <pthread.h>

#include <cstdio>
#include <stdexcept>
#include <string>
#include <vector>

struct Point {
    int x;
    int y;
};

Point global_origin{0, 0};
int counter = 0;
pthread_mutex_t counter_mutex = PTHREAD_MUTEX_INITIALIZER;

int add(int a, int b) { return a + b; }

long factorial(int n) {
    if (n <= 1) {
        return 1;
    }
    return n * factorial(n - 1);
}

int sum(const std::vector<int>& values) {
    int total = 0;
    for (int value : values) {
        total += value;
    }
    return total;
}

double average(const std::vector<int>& values) {
    return static_cast<double>(sum(values)) / static_cast<double>(values.size());
}

void* worker(void* argument) {
    const int id = *static_cast<int*>(argument);
    for (int i = 0; i < 3; i++) {
        pthread_mutex_lock(&counter_mutex);
        counter += id;
        pthread_mutex_unlock(&counter_mutex);
    }
    return nullptr;
}

void risky(int value) {
    if (value < 0) {
        throw std::runtime_error("negative value");
    }
    std::printf("risky(%d)\n", value);
}

int main(int argc, char** argv) {
    (void)argv;
    std::printf("cpp-demo starting (argc=%d)\n", argc);

    Point point{3, 4};
    Point* point_ptr = &point;
    std::vector<int> values{1, 2, 3, 4, 5};
    std::string label = "demo";
    int total = 0;

    for (std::size_t i = 0; i < values.size(); i++) {
        total = add(total, values[i]);
        std::printf("i=%zu total=%d\n", i, total);
    }

    std::printf("factorial(6)=%ld\n", factorial(6));
    std::printf("average=%.2f label=%s point=(%d,%d) point_ptr->x=%d\n", average(values),
                label.c_str(), point.x, point.y, point_ptr->x);

    try {
        risky(-1);
    } catch (const std::exception& error) {
        std::printf("caught: %s\n", error.what());
    }

    int ids[2] = {1, 2};
    pthread_t threads[2];
    for (int i = 0; i < 2; i++) {
        pthread_create(&threads[i], nullptr, worker, &ids[i]);
    }
    for (int i = 0; i < 2; i++) {
        pthread_join(threads[i], nullptr);
    }

    std::printf("counter=%d total=%d\n", counter, total);
    return 0;
}
