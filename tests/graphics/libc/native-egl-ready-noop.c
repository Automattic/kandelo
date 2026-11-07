/* Native client-only control has no EGL facade/unlock queue. Never link this
 * fallback into the SDK/product; real facade integration has its own controls. */
__attribute__((weak)) void _wpk_egl_request_native_drain(void) {}
