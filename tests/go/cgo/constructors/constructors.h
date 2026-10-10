#ifndef KANDELO_GO_CGO_CONSTRUCTORS_H
#define KANDELO_GO_CGO_CONSTRUCTORS_H

unsigned int constructor_count(void);
int constructor_value(void);
int run_destructors(void);
void request_c_exit(void);
void request_c_immediate_exit(void);
void expect_no_exit_handler(void);

#endif
