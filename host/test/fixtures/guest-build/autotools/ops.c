#include "ops.h"

int ops_apply(char op, int left, int right) {
    switch (op) {
    case '+': return left + right;
    case '*': return left * right;
    default: return 0;
    }
}
