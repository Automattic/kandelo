/* POSIX message-source compiler for musl's big-endian catalog format.
 * Source syntax: https://pubs.opengroup.org/onlinepubs/7908799/xcu/gencat.html
 * The existing catalog is read and validated before any output is replaced.
 */
#include <nl_types.h>

struct catalog_message {
    int set, id;
    char *text;
    struct catalog_message *next;
};

static uint32_t catalog_u32(const unsigned char *p) {
    return (uint32_t)p[0] << 24 | (uint32_t)p[1] << 16 |
           (uint32_t)p[2] << 8 | p[3];
}

static void catalog_put32(unsigned char *p, uint32_t v) {
    p[0] = v >> 24; p[1] = v >> 16; p[2] = v >> 8; p[3] = v;
}

static void catalog_free(struct catalog_message *messages) {
    while (messages) {
        struct catalog_message *next = messages->next;
        free(messages->text);
        free(messages);
        messages = next;
    }
}

static int catalog_set(struct catalog_message **messages, int set, int id,
                       const char *text) {
    struct catalog_message **slot = messages;
    while (*slot && ((*slot)->set < set ||
           ((*slot)->set == set && (*slot)->id < id))) slot = &(*slot)->next;
    if (*slot && (*slot)->set == set && (*slot)->id == id) {
        struct catalog_message *old = *slot;
        *slot = old->next;
        free(old->text);
        free(old);
    }
    if (!text) return 0;
    struct catalog_message *entry = malloc(sizeof(*entry));
    if (!entry) return -1;
    entry->text = strdup(text);
    if (!entry->text) { free(entry); return -1; }
    entry->set = set; entry->id = id; entry->next = *slot;
    *slot = entry;
    return 0;
}

static int catalog_load(const char *path, struct catalog_message **messages) {
    FILE *in = fopen(path, "rb");
    if (!in) return errno == ENOENT ? 0 : -1;
    unsigned char *data = NULL;
    int rc = -1;
    if (fseek(in, 0, SEEK_END) != 0) goto done;
    long length = ftell(in);
    if (length < 20 || (uint64_t)length > UINT32_MAX ||
        fseek(in, 0, SEEK_SET) != 0) { errno = EINVAL; goto done; }
    data = malloc((size_t)length);
    if (!data) goto done;
    if (fread(data, 1, length, in) != (size_t)length) goto done;
    uint32_t sets = catalog_u32(data + 4), size = catalog_u32(data + 8);
    uint32_t msg_off = catalog_u32(data + 12), str_off = catalog_u32(data + 16);
    if (catalog_u32(data) != 0xff88ff89 || (uint64_t)size + 20 != (uint64_t)length ||
        sets > size / 12 || msg_off != sets * 12 || str_off < msg_off ||
        str_off > size || (str_off - msg_off) % 12) { errno = EINVAL; goto done; }
    uint32_t total_msgs = (str_off - msg_off) / 12, previous_set = 0;
    for (uint32_t i = 0; i < sets; i++) {
        const unsigned char *s = data + 20 + i * 12;
        uint32_t set = catalog_u32(s), count = catalog_u32(s + 4);
        uint32_t first = catalog_u32(s + 8), previous_msg = 0;
        if (!set || set > NL_SETMAX || set <= previous_set ||
            first > total_msgs || count > total_msgs - first) { errno = EINVAL; goto done; }
        previous_set = set;
        for (uint32_t j = 0; j < count; j++) {
            const unsigned char *m = data + 20 + msg_off + (first + j) * 12;
            uint32_t id = catalog_u32(m), len = catalog_u32(m + 4), off = catalog_u32(m + 8);
            if (!id || id > NL_MSGMAX || id <= previous_msg || !len ||
                off > size - str_off || len > size - str_off - off ||
                data[20 + str_off + off + len - 1] != 0) { errno = EINVAL; goto done; }
            previous_msg = id;
            if (catalog_set(messages, set, id, (char *)data + 20 + str_off + off)) goto done;
        }
    }
    rc = 0;
done:
    free(data);
    if (fclose(in) && rc == 0) rc = -1;
    return rc;
}

static char *catalog_skip_blanks(char *p) {
    while (*p == ' ' || *p == '\t') p++;
    return p;
}

static int catalog_id(char *p, char **end, long maximum) {
    errno = 0;
    long id = strtol(p, end, 10);
    if (errno || *end == p || id < 1 || id > maximum ||
        (**end && **end != ' ' && **end != '\t')) return -1;
    return (int)id;
}

static int catalog_parse(FILE *in, struct catalog_message **messages) {
    char *line = NULL;
    size_t capacity = 0;
    ssize_t length;
    int set = NL_SETD, quote = 0, rc = -1;
    while ((length = getline(&line, &capacity, in)) >= 0) {
        /* An odd trailing backslash continues the logical source line. */
        while (length && line[length - 1] == '\n') {
            size_t slashes = 0;
            for (ssize_t i = length - 2; i >= 0 && line[i] == '\\'; i--) slashes++;
            line[--length] = 0;
            if (!(slashes % 2)) break;
            line[--length] = 0;
            char *part = NULL; size_t part_capacity = 0;
            ssize_t part_length = getline(&part, &part_capacity, in);
            if (part_length < 0) { free(part); errno = EINVAL; goto done; }
            if ((size_t)part_length > SIZE_MAX - (size_t)length - 1) {
                free(part); errno = EOVERFLOW; goto done;
            }
            size_t needed = length + part_length + 1;
            char *joined = realloc(line, needed);
            if (!joined) { free(part); goto done; }
            line = joined; capacity = needed;
            memcpy(line + length, part, part_length + 1);
            length += part_length;
            free(part);
        }
        if (!*line || (line[0] == '$' && (line[1] == ' ' || line[1] == '\t'))) continue;
        if (line[0] == '$') {
            char *end;
            if (!strncmp(line, "$set", 4) && (line[4] == ' ' || line[4] == '\t')) {
                int id = catalog_id(catalog_skip_blanks(line + 4), &end, NL_SETMAX);
                if (id < 0) { errno = EINVAL; goto done; }
                set = id;
            } else if (!strncmp(line, "$delset", 7) && (line[7] == ' ' || line[7] == '\t')) {
                int id = catalog_id(catalog_skip_blanks(line + 7), &end, NL_SETMAX);
                if (id < 0) { errno = EINVAL; goto done; }
                struct catalog_message **p = messages;
                while (*p) {
                    if ((*p)->set == id) {
                        struct catalog_message *old = *p;
                        *p = old->next; free(old->text); free(old);
                    } else p = &(*p)->next;
                }
            } else if (!strncmp(line, "$quote", 6) && (!line[6] || line[6] == ' ' || line[6] == '\t')) {
                quote = (unsigned char)*catalog_skip_blanks(line + 6);
            } else { errno = EINVAL; goto done; }
            continue;
        }
        char *p;
        int id = catalog_id(line, &p, NL_MSGMAX);
        if (id < 0) { errno = EINVAL; goto done; }
        if (!*p) {
            if (catalog_set(messages, set, id, NULL)) goto done;
            continue;
        }
        /* Exactly one field separator; further blanks belong to the text. */
        p++;
        int quoted = quote && (unsigned char)*p == quote;
        if (quoted) p++;
        char *text = malloc(strlen(p) + 1), *out = text;
        if (!text) goto done;
        int closed = !quoted;
        while (*p) {
            unsigned char ch = *p++;
            if (quoted && ch == quote) { closed = 1; break; }
            if (ch == '\\' && *p) {
                ch = *p++;
                switch (ch) {
                    case 'n': ch = '\n'; break; case 't': ch = '\t'; break;
                    case 'v': ch = '\v'; break; case 'b': ch = '\b'; break;
                    case 'r': ch = '\r'; break; case 'f': ch = '\f'; break;
                    default:
                        if (ch >= '0' && ch <= '7') {
                            unsigned value = ch - '0';
                            for (int i = 1; i < 3 && *p >= '0' && *p <= '7'; i++) value = value * 8 + (*p++ - '0');
                            ch = value;
                        }
                }
            }
            *out++ = ch;
        }
        *out = 0;
        if (!closed || out - text > NL_TEXTMAX) { free(text); errno = EINVAL; goto done; }
        int added = catalog_set(messages, set, id, text);
        free(text);
        if (added) goto done;
    }
    if (ferror(in)) goto done;
    rc = 0;
done:
    free(line);
    return rc;
}

static int catalog_write(FILE *out, struct catalog_message *messages) {
    uint64_t count = 0, sets = 0, strings = 0;
    int previous_set = 0;
    for (struct catalog_message *m = messages; m; m = m->next) {
        count++; strings += strlen(m->text) + 1;
        if (m->set != previous_set) { sets++; previous_set = m->set; }
    }
    uint64_t size = sets * 12 + count * 12 + strings;
    if (size > UINT32_MAX - 20) { errno = EOVERFLOW; return -1; }
    unsigned char *data = calloc(1, (size_t)size + 20);
    if (!data) return -1;
    catalog_put32(data, 0xff88ff89); catalog_put32(data + 4, sets);
    catalog_put32(data + 8, size); catalog_put32(data + 12, sets * 12);
    catalog_put32(data + 16, sets * 12 + count * 12);
    unsigned char *s = data + 20, *p = data + 20 + sets * 12;
    unsigned char *texts = p + count * 12;
    uint32_t index = 0, offset = 0;
    for (struct catalog_message *m = messages; m;) {
        int set = m->set;
        catalog_put32(s, set); catalog_put32(s + 8, index);
        uint32_t n = 0;
        while (m && m->set == set) {
            size_t length = strlen(m->text) + 1;
            catalog_put32(p, m->id); catalog_put32(p + 4, length); catalog_put32(p + 8, offset);
            memcpy(texts + offset, m->text, length);
            offset += length; index++; n++; p += 12; m = m->next;
        }
        catalog_put32(s + 4, n); s += 12;
    }
    int rc = fwrite(data, 1, size + 20, out) == size + 20 ? 0 : -1;
    free(data);
    return rc;
}

static int util_gencat(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "gencat: usage: gencat catalog [msgfile...]\n"); return 1; }
    struct catalog_message *messages = NULL;
    int rc = 1;
    if (strcmp(argv[1], "-") && catalog_load(argv[1], &messages)) goto done;
    if (argc == 2 && catalog_parse(stdin, &messages)) goto done;
    for (int i = 2; i < argc; i++) {
        FILE *in = strcmp(argv[i], "-") ? fopen(argv[i], "r") : stdin;
        if (!in) goto done;
        int parsed = catalog_parse(in, &messages);
        if (in != stdin && fclose(in) && parsed == 0) parsed = -1;
        if (parsed) goto done;
    }
    if (!strcmp(argv[1], "-")) {
        if (!catalog_write(stdout, messages) && !fflush(stdout)) rc = 0;
    } else {
        struct stat existing;
        mode_t mask = umask(0); umask(mask);
        mode_t mode = stat(argv[1], &existing) == 0 ? existing.st_mode & 0777 : 0666 & ~mask;
        char *temporary = malloc(strlen(argv[1]) + sizeof(".XXXXXX"));
        if (!temporary) goto done;
        sprintf(temporary, "%s.XXXXXX", argv[1]);
        int fd = mkstemp(temporary);
        FILE *out = fd < 0 ? NULL : fdopen(fd, "wb");
        if (!out) { if (fd >= 0) close(fd); }
        else {
            int written = catalog_write(out, messages);
            if (fchmod(fd, mode)) written = -1;
            if (fclose(out)) written = -1;
            if (!written && !rename(temporary, argv[1])) rc = 0;
        }
        if (rc) unlink(temporary);
        free(temporary);
    }
done:
    if (rc) perror("gencat");
    catalog_free(messages);
    return rc;
}
