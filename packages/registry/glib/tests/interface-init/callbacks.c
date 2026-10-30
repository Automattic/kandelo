#include "contract.h"
int callback_count;
void callback_one(Payload *iface) {
  callback_count++;
  iface->value = 11;
}
void callback_two(gpointer iface, gpointer data) {
  callback_count++;
  ((Payload *)iface)->value = data == NULL ? 22 : -22;
}
void callback_typed_two(Payload *iface, gpointer data) {
  callback_count++;
  iface->value = data == NULL ? 33 : -33;
}
