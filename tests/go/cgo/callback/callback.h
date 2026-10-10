#ifndef KANDELO_CGO_CALLBACK_H
#define KANDELO_CGO_CALLBACK_H

int call_go(int value);
int call_go_on_pthread(int value);
int call_go_message_on_pthread(void);
int call_go_deep_on_pthread(void);
int call_go_on_pthreads(void);

#endif
