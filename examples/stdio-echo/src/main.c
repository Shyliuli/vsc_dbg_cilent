// Interactive demo: the program reads stdin. With console "integratedTerminal"
// gdb attaches the inferior to a pty created by gdb-client, so input works.
#include <stdio.h>

int main(void) {
    char name[128];
    int value = 0;

    printf("name? ");
    fflush(stdout);
    if (scanf("%127s", name) != 1) {
        printf("\nno name provided\n");
        return 1;
    }

    printf("value? ");
    fflush(stdout);
    if (scanf("%d", &value) != 1) {
        printf("\nno value provided\n");
        return 1;
    }

    printf("hello %s, doubled=%d\n", name, value * 2);
    return 0;
}
