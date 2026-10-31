#ifndef INTERFACE_INIT_CONTRACT_H
#define INTERFACE_INIT_CONTRACT_H
#ifdef __cplusplus
#define NULL nullptr
#else
#define NULL ((void *)0)
#endif
typedef void *gpointer;
typedef void (*GInterfaceInitFunc)(gpointer, gpointer);
typedef struct {
  GInterfaceInitFunc interface_init;
  GInterfaceInitFunc interface_finalize;
  gpointer interface_data;
} GInterfaceInfo;
typedef struct { int value; } Payload;
extern int callback_count;
#ifdef __cplusplus
extern "C" {
#endif
void callback_one(Payload *iface);
void callback_two(gpointer iface, gpointer data);
void callback_typed_two(Payload *iface, gpointer data);
void g_wasm_iface_init_thunk(gpointer iface, gpointer callback);
void g_type_add_interface_static(unsigned type, unsigned iface, const GInterfaceInfo *info);
void g_type_module_add_interface(gpointer module, unsigned type, unsigned iface,
                                const GInterfaceInfo *info);
void register_case(int which);
int run_case(int which);
int calls(void);
#ifdef __cplusplus
}
#endif
#endif
