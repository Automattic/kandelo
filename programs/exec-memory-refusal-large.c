static volatile unsigned char storage[64u * 1024u * 1024u];

int main(void)
{
    return storage[sizeof(storage) - 1] == 0 ? 42 : 43;
}
