/* An unused call must not make its missing target a link root. */
extern void wasm32_unused_missing_target(void);

void wasm32_unused_function(void)
{
    wasm32_unused_missing_target();
}

int wasm32_live_function(void)
{
    return 29;
}

int plus_seventeen(int value)
{
    return value + 17;
}
