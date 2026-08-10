#include <stdio.h>
#include <string.h>

int main(int argc, char **argv) {
    if (argc != 4 ||
        strcmp(argv[1], "-MFile::Spec") != 0 ||
        strcmp(argv[2], "-e") != 0 ||
        strcmp(argv[3], "print qq(perl-ready\\n)") != 0) {
        fputs("unexpected protected Perl probe arguments\n", stderr);
        return 64;
    }

    FILE *module = fopen("/usr/lib/perl5/5.40.3/File/Spec.pm", "rb");
    if (module == NULL) {
        fputs("missing protected Perl standard-library fixture\n", stderr);
        return 66;
    }
    char contents[64] = {0};
    size_t read = fread(contents, 1, sizeof(contents) - 1, module);
    if (fclose(module) != 0 || read == 0 ||
        strstr(contents, "fixture File::Spec") == NULL) {
        fputs("invalid protected Perl standard-library fixture\n", stderr);
        return 65;
    }

    puts("perl-ready");
    return 0;
}
