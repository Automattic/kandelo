/*
 * gencat ��� Compile message catalog source into musl binary format.
 *
 * musl catalog format (big-endian):
 *   Header (20 bytes):
 *     [0..4]   magic = 0xff88ff89
 *     [4..8]   nsets
 *     [8..12]  total_size (file size - 20)
 *     [12..16] msgs_offset (offset to messages array, from byte 20)
 *     [16..20] strings_offset (offset to strings area, from byte 20)
 *   Sets array (12 bytes each):
 *     [0..4]   set_id (big-endian)
 *     [4..8]   nmsgs
 *     [8..12]  first_msg_index
 *   Messages array (12 bytes each):
 *     [0..4]   msg_id (big-endian)
 *     [4..8]   msg_len (including NUL)
 *     [8..12]  string_offset (offset into strings area)
 *   Strings area (NUL-terminated strings)
 *
 * Usage: gencat catfile msgfile...
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <ctype.h>

/* Big-endian helpers */
static void put32be(unsigned char *p, uint32_t v)
{
    p[0] = (v >> 24) & 0xff;
    p[1] = (v >> 16) & 0xff;
    p[2] = (v >>  8) & 0xff;
    p[3] =  v        & 0xff;
}

#define MAX_SETS 256
#define MAX_MSGS 4096
#define MAX_STRINGS (256 * 1024)

struct msg {
    int set_id;
    int msg_id;
    int str_offset;
    int str_len; /* including NUL */
};

static struct msg msgs[MAX_MSGS];
static int nmsg;
static char strings[MAX_STRINGS];
static int string_pos;

static int sets[MAX_SETS];
static int nsets;

static void add_set(int id)
{
    for (int i = 0; i < nsets; i++)
        if (sets[i] == id) return;
    if (nsets >= MAX_SETS) {
        fprintf(stderr, "gencat: too many sets\n");
        exit(1);
    }
    sets[nsets++] = id;
}

static int cmp_msg(const void *a, const void *b)
{
    const struct msg *ma = a, *mb = b;
    if (ma->set_id != mb->set_id)
        return ma->set_id - mb->set_id;
    return ma->msg_id - mb->msg_id;
}

static int cmp_int(const void *a, const void *b)
{
    return *(const int *)a - *(const int *)b;
}

static void parse_file(const char *path)
{
    FILE *f = fopen(path, "r");
    if (!f) {
        perror(path);
        exit(1);
    }
    int cur_set = 1;
    char line[4096];
    while (fgets(line, sizeof line, f)) {
        /* Strip trailing newline */
        size_t len = strlen(line);
        while (len > 0 && (line[len-1] == '\n' || line[len-1] == '\r'))
            line[--len] = 0;

        if (line[0] == '$') {
            /* Directive */
            if (strncmp(line, "$set", 4) == 0) {
                cur_set = atoi(line + 4);
                add_set(cur_set);
            }
            /* $delset, $quote, etc. — ignore */
            continue;
        }
        /* Skip blank/comment lines */
        if (!isdigit((unsigned char)line[0]))
            continue;

        /* Parse "N text" */
        char *end;
        int msg_id = (int)strtol(line, &end, 10);
        if (end == line) continue;
        while (*end == ' ' || *end == '\t') end++;
        const char *text = end;
        size_t text_len = strlen(text);

        add_set(cur_set);

        if (nmsg >= MAX_MSGS) {
            fprintf(stderr, "gencat: too many messages\n");
            exit(1);
        }
        if (string_pos + (int)text_len + 1 > MAX_STRINGS) {
            fprintf(stderr, "gencat: string area overflow\n");
            exit(1);
        }

        msgs[nmsg].set_id = cur_set;
        msgs[nmsg].msg_id = msg_id;
        msgs[nmsg].str_offset = string_pos;
        msgs[nmsg].str_len = (int)text_len + 1;
        memcpy(strings + string_pos, text, text_len + 1);
        string_pos += (int)text_len + 1;
        nmsg++;
    }
    fclose(f);
}

int main(int argc, char *argv[])
{
    if (argc < 3) {
        fprintf(stderr, "usage: gencat catfile msgfile...\n");
        return 1;
    }

    const char *catfile = argv[1];

    for (int i = 2; i < argc; i++)
        parse_file(argv[i]);

    /* Sort sets and messages */
    qsort(sets, nsets, sizeof(int), cmp_int);
    qsort(msgs, nmsg, sizeof(struct msg), cmp_msg);

    /* Build the binary catalog */
    /* Layout: header(20) + sets(nsets*12) + msgs(nmsg*12) + strings(string_pos) */
    uint32_t sets_size = nsets * 12;
    uint32_t msgs_size = nmsg * 12;
    uint32_t total_size = sets_size + msgs_size + string_pos;
    uint32_t file_size = 20 + total_size;

    unsigned char *buf = calloc(1, file_size);
    if (!buf) {
        perror("calloc");
        return 1;
    }

    /* Header */
    put32be(buf + 0, 0xff88ff89);        /* magic */
    put32be(buf + 4, (uint32_t)nsets);    /* nsets */
    put32be(buf + 8, total_size);         /* total_size */
    put32be(buf + 12, sets_size);         /* msgs_offset */
    put32be(buf + 16, sets_size + msgs_size); /* strings_offset */

    /* Sets array */
    unsigned char *sp = buf + 20;
    int msg_idx = 0;
    for (int i = 0; i < nsets; i++) {
        int set_id = sets[i];
        int first = msg_idx;
        int count = 0;
        while (msg_idx < nmsg && msgs[msg_idx].set_id == set_id) {
            msg_idx++;
            count++;
        }
        put32be(sp + 0, (uint32_t)set_id);
        put32be(sp + 4, (uint32_t)count);
        put32be(sp + 8, (uint32_t)first);
        sp += 12;
    }

    /* Messages array */
    unsigned char *mp = buf + 20 + sets_size;
    for (int i = 0; i < nmsg; i++) {
        put32be(mp + 0, (uint32_t)msgs[i].msg_id);
        put32be(mp + 4, (uint32_t)msgs[i].str_len);
        put32be(mp + 8, (uint32_t)msgs[i].str_offset);
        mp += 12;
    }

    /* Strings area */
    memcpy(buf + 20 + sets_size + msgs_size, strings, string_pos);

    /* Write output */
    FILE *out = fopen(catfile, "wb");
    if (!out) {
        perror(catfile);
        return 1;
    }
    if (fwrite(buf, 1, file_size, out) != file_size) {
        perror("fwrite");
        fclose(out);
        return 1;
    }
    fclose(out);
    free(buf);

    return 0;
}
