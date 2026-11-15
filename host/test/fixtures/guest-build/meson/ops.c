#include "ops.h"

long ops_apply(char op, long left, long right) {
    switch (op) {
    case '+': return left + right;
    case '*': return left * right;
    default: return 0;
    }
}
