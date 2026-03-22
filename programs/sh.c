/*
 * sh.c — Minimal POSIX shell for wasm-posix-kernel.
 *
 * Supports: -c "cmd" mode, stdin mode, pipelines, &&/||, ;,
 * if/elif/else/fi, while/do/done, for/in/do/done, { },
 * redirections (>, >>, <, 2>&1), variable expansion ($VAR, $$, $?),
 * single/double quoting, builtins (echo, exit, test/[, read, export,
 * unset, cd, true, false, :, kill).
 *
 * No malloc — uses static arena allocator for AST nodes and
 * fixed-size buffers throughout.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/wait.h>
#include <fcntl.h>
#include <signal.h>
#include <errno.h>
#include <sys/stat.h>
#include <ctype.h>

/* ================================================================
 * Constants and limits
 * ================================================================ */

#define MAX_LINE      8192
#define MAX_ARGS      128
#define MAX_WORD      4096
#define MAX_NODES     512
#define MAX_VARS      64
#define MAX_REDIRS    16
#define MAX_PIPE_CMDS 32
#define MAX_FOR_WORDS 128

/* ================================================================
 * Shell state
 * ================================================================ */

static int last_status = 0;
static char *shell_argv0 = "sh";

/* Shell-local variable table (for read builtin etc.) */
struct var {
    char name[64];
    char value[MAX_WORD];
};
static struct var vars[MAX_VARS];
static int var_count = 0;

static void set_var(const char *name, const char *value) {
    for (int i = 0; i < var_count; i++) {
        if (strcmp(vars[i].name, name) == 0) {
            strncpy(vars[i].value, value, MAX_WORD - 1);
            vars[i].value[MAX_WORD - 1] = '\0';
            return;
        }
    }
    if (var_count < MAX_VARS) {
        strncpy(vars[var_count].name, name, 63);
        vars[var_count].name[63] = '\0';
        strncpy(vars[var_count].value, value, MAX_WORD - 1);
        vars[var_count].value[MAX_WORD - 1] = '\0';
        var_count++;
    }
}

static const char *get_var(const char *name) {
    for (int i = 0; i < var_count; i++) {
        if (strcmp(vars[i].name, name) == 0)
            return vars[i].value;
    }
    return getenv(name);
}

static void unset_var(const char *name) {
    for (int i = 0; i < var_count; i++) {
        if (strcmp(vars[i].name, name) == 0) {
            vars[i] = vars[--var_count];
            return;
        }
    }
    unsetenv(name);
}

/* ================================================================
 * Token types
 * ================================================================ */

enum token_type {
    TOK_WORD,
    TOK_AND,        /* && */
    TOK_OR,         /* || */
    TOK_SEMI,       /* ; */
    TOK_PIPE,       /* | */
    TOK_LBRACE,     /* { */
    TOK_RBRACE,     /* } */
    TOK_LPAREN,     /* ( */
    TOK_RPAREN,     /* ) */
    TOK_REDIR_OUT,  /* > */
    TOK_REDIR_APPEND, /* >> */
    TOK_REDIR_IN,   /* < */
    TOK_NEWLINE,
    TOK_EOF,
};

struct token {
    enum token_type type;
    char word[MAX_WORD];
};

/* ================================================================
 * Tokenizer
 * ================================================================ */

static const char *tok_pos;
static struct token cur_tok;
static int tok_peeked;

static int is_special(char c) {
    return c == '|' || c == '&' || c == ';' || c == '>' || c == '<'
        || c == '{' || c == '}' || c == '(' || c == ')' || c == '\n';
}

static int is_word_char(char c) {
    return c != '\0' && !isspace(c) && !is_special(c);
}

/* Expand variables in a word, writing result to dst.
 * Handles $VAR, ${VAR}, $$, $?, $0, single/double quoting, backslash. */
static void expand_word(const char *src, char *dst, int dst_size) {
    char *out = dst;
    char *end = dst + dst_size - 1;
    int in_single = 0;
    int in_double = 0;

    while (*src && out < end) {
        if (*src == '\\' && !in_single) {
            src++;
            if (*src) *out++ = *src++;
            continue;
        }
        if (*src == '\'' && !in_double) {
            in_single = !in_single;
            src++;
            continue;
        }
        if (*src == '"' && !in_single) {
            in_double = !in_double;
            src++;
            continue;
        }
        if (*src == '$' && !in_single) {
            src++;
            if (*src == '$') {
                /* $$ = pid */
                char tmp[32];
                snprintf(tmp, sizeof(tmp), "%d", (int)getpid());
                for (char *t = tmp; *t && out < end; )
                    *out++ = *t++;
                src++;
            } else if (*src == '?') {
                /* $? = last exit status */
                char tmp[32];
                snprintf(tmp, sizeof(tmp), "%d", last_status);
                for (char *t = tmp; *t && out < end; )
                    *out++ = *t++;
                src++;
            } else if (*src == '0') {
                /* $0 = shell name */
                for (char *t = shell_argv0; *t && out < end; )
                    *out++ = *t++;
                src++;
            } else if (*src == '{') {
                /* ${VAR} */
                src++;
                char name[64];
                int ni = 0;
                while (*src && *src != '}' && ni < 63)
                    name[ni++] = *src++;
                name[ni] = '\0';
                if (*src == '}') src++;
                const char *val = get_var(name);
                if (val) {
                    while (*val && out < end)
                        *out++ = *val++;
                }
            } else if (isalpha(*src) || *src == '_') {
                /* $VAR */
                char name[64];
                int ni = 0;
                while ((isalnum(*src) || *src == '_') && ni < 63)
                    name[ni++] = *src++;
                name[ni] = '\0';
                const char *val = get_var(name);
                if (val) {
                    while (*val && out < end)
                        *out++ = *val++;
                }
            } else {
                /* Literal $ */
                *out++ = '$';
            }
            continue;
        }
        *out++ = *src++;
    }
    *out = '\0';
}

/* Read next raw token from tok_pos. Handles quoting so that quoted
 * strings are consumed as a single WORD token. */
static void read_token(void) {
    /* Skip whitespace (but not newlines) */
    while (*tok_pos == ' ' || *tok_pos == '\t')
        tok_pos++;

    /* Skip comments */
    if (*tok_pos == '#') {
        while (*tok_pos && *tok_pos != '\n')
            tok_pos++;
    }

    if (*tok_pos == '\0') {
        cur_tok.type = TOK_EOF;
        cur_tok.word[0] = '\0';
        return;
    }

    if (*tok_pos == '\n') {
        cur_tok.type = TOK_NEWLINE;
        cur_tok.word[0] = '\n';
        cur_tok.word[1] = '\0';
        tok_pos++;
        return;
    }

    /* Two-char operators */
    if (tok_pos[0] == '&' && tok_pos[1] == '&') {
        cur_tok.type = TOK_AND;
        strcpy(cur_tok.word, "&&");
        tok_pos += 2;
        return;
    }
    if (tok_pos[0] == '|' && tok_pos[1] == '|') {
        cur_tok.type = TOK_OR;
        strcpy(cur_tok.word, "||");
        tok_pos += 2;
        return;
    }
    if (tok_pos[0] == '>' && tok_pos[1] == '>') {
        cur_tok.type = TOK_REDIR_APPEND;
        strcpy(cur_tok.word, ">>");
        tok_pos += 2;
        return;
    }

    /* Single-char operators */
    switch (*tok_pos) {
    case '|':  cur_tok.type = TOK_PIPE; strcpy(cur_tok.word, "|"); tok_pos++; return;
    case ';':  cur_tok.type = TOK_SEMI; strcpy(cur_tok.word, ";"); tok_pos++; return;
    case '{':  cur_tok.type = TOK_LBRACE; strcpy(cur_tok.word, "{"); tok_pos++; return;
    case '}':  cur_tok.type = TOK_RBRACE; strcpy(cur_tok.word, "}"); tok_pos++; return;
    case '(':  cur_tok.type = TOK_LPAREN; strcpy(cur_tok.word, "("); tok_pos++; return;
    case ')':  cur_tok.type = TOK_RPAREN; strcpy(cur_tok.word, ")"); tok_pos++; return;
    case '>':  cur_tok.type = TOK_REDIR_OUT; strcpy(cur_tok.word, ">"); tok_pos++; return;
    case '<':  cur_tok.type = TOK_REDIR_IN; strcpy(cur_tok.word, "<"); tok_pos++; return;
    }

    /* Word: may contain quotes */
    cur_tok.type = TOK_WORD;
    char *out = cur_tok.word;
    char *wend = cur_tok.word + MAX_WORD - 1;
    int in_single = 0, in_double = 0;

    while (*tok_pos && out < wend) {
        if (*tok_pos == '\\' && !in_single) {
            /* Copy backslash + next char literally into token */
            *out++ = *tok_pos++;
            if (*tok_pos && out < wend)
                *out++ = *tok_pos++;
            continue;
        }
        if (*tok_pos == '\'' && !in_double) {
            *out++ = *tok_pos++;
            in_single = !in_single;
            continue;
        }
        if (*tok_pos == '"' && !in_single) {
            *out++ = *tok_pos++;
            in_double = !in_double;
            continue;
        }
        if (!in_single && !in_double) {
            if (isspace(*tok_pos) || is_special(*tok_pos))
                break;
        }
        *out++ = *tok_pos++;
    }
    *out = '\0';
}

static void next_token(void) {
    if (tok_peeked) {
        tok_peeked = 0;
        return;
    }
    read_token();
}

static struct token *peek_token(void) {
    if (!tok_peeked) {
        read_token();
        tok_peeked = 1;
    }
    return &cur_tok;
}

/* Check if a word is a keyword */
static int is_keyword(const char *w) {
    return strcmp(w, "if") == 0 || strcmp(w, "then") == 0
        || strcmp(w, "elif") == 0 || strcmp(w, "else") == 0
        || strcmp(w, "fi") == 0 || strcmp(w, "while") == 0
        || strcmp(w, "for") == 0 || strcmp(w, "do") == 0
        || strcmp(w, "done") == 0 || strcmp(w, "in") == 0
        || strcmp(w, "case") == 0 || strcmp(w, "esac") == 0;
}

/* Skip newlines and semicolons (line terminators between commands) */
static void skip_newlines(void) {
    while (peek_token()->type == TOK_NEWLINE || peek_token()->type == TOK_SEMI) {
        next_token();
    }
}

/* ================================================================
 * AST
 * ================================================================ */

enum node_type {
    NODE_SIMPLE,
    NODE_PIPELINE,
    NODE_AND,
    NODE_OR,
    NODE_SEQUENCE,
    NODE_BRACE,
    NODE_IF,
    NODE_WHILE,
    NODE_FOR,
    NODE_SUBSHELL,
};

struct redir {
    int fd;           /* file descriptor to redirect (0=stdin, 1=stdout, 2=stderr) */
    int mode;         /* O_WRONLY|O_CREAT|O_TRUNC, O_WRONLY|O_CREAT|O_APPEND, O_RDONLY */
    int dup_fd;       /* for 2>&1 style: target fd, else -1 */
    char file[MAX_WORD];
};

struct node {
    enum node_type type;

    /* NODE_SIMPLE */
    char *args[MAX_ARGS];
    int argc;
    struct redir redirs[MAX_REDIRS];
    int redir_count;

    /* NODE_PIPELINE: left | right */
    /* NODE_AND, NODE_OR, NODE_SEQUENCE: left op right */
    struct node *left;
    struct node *right;

    /* NODE_BRACE, NODE_SUBSHELL: body */
    struct node *body;

    /* NODE_IF: condition=left, then_body=right, else_body=else_part */
    /* condition, then_body in left/right; elif/else chain: */
    struct node *else_part;

    /* NODE_WHILE: condition=left, body=right */

    /* NODE_FOR: var_name, word_list, body */
    char for_var[64];
    char *for_words[MAX_FOR_WORDS];
    int for_word_count;
};

/* Static arena allocator */
static struct node node_pool[MAX_NODES];
static int node_next = 0;

/* String storage arena */
#define STRING_ARENA_SIZE (256 * 1024)
static char string_arena[STRING_ARENA_SIZE];
static int string_next = 0;

static char *arena_strdup(const char *s) {
    int len = strlen(s) + 1;
    if (string_next + len > STRING_ARENA_SIZE) {
        fprintf(stderr, "sh: string arena exhausted\n");
        return "";
    }
    char *p = &string_arena[string_next];
    memcpy(p, s, len);
    string_next += len;
    return p;
}

static struct node *alloc_node(enum node_type type) {
    if (node_next >= MAX_NODES) {
        fprintf(stderr, "sh: AST node pool exhausted\n");
        return &node_pool[0]; /* emergency reuse */
    }
    struct node *n = &node_pool[node_next++];
    memset(n, 0, sizeof(*n));
    n->type = type;
    return n;
}

/* ================================================================
 * Parser — recursive descent
 * ================================================================ */

static struct node *parse_list(void);
static struct node *parse_and_or(void);
static struct node *parse_pipeline(void);
static struct node *parse_command(void);
static struct node *parse_simple(void);

/* simple_command = (WORD | redirection)+ */
static struct node *parse_simple(void) {
    struct node *n = alloc_node(NODE_SIMPLE);

    while (1) {
        struct token *t = peek_token();

        /* Handle redirections */
        if (t->type == TOK_REDIR_OUT || t->type == TOK_REDIR_APPEND || t->type == TOK_REDIR_IN) {
            if (n->redir_count >= MAX_REDIRS) break;
            struct redir *r = &n->redirs[n->redir_count++];
            r->dup_fd = -1;

            if (t->type == TOK_REDIR_OUT) {
                r->fd = 1;
                r->mode = O_WRONLY | O_CREAT | O_TRUNC;
            } else if (t->type == TOK_REDIR_APPEND) {
                r->fd = 1;
                r->mode = O_WRONLY | O_CREAT | O_APPEND;
            } else {
                r->fd = 0;
                r->mode = O_RDONLY;
            }
            next_token();

            /* Get the filename */
            t = peek_token();
            if (t->type != TOK_WORD) {
                fprintf(stderr, "sh: expected filename after redirect\n");
                break;
            }
            /* Expand the filename */
            expand_word(t->word, r->file, MAX_WORD);
            next_token();
            continue;
        }

        if (t->type != TOK_WORD) break;

        /* Check for fd-redirect pattern like "2>&1" or "2>file" */
        if (t->word[0] >= '0' && t->word[0] <= '9') {
            int fd_num = t->word[0] - '0';
            if (t->word[1] == '\0') {
                /* Could be "2" followed by ">" — check next */
                struct token saved = *t;
                const char *saved_pos = tok_pos;
                int saved_peeked = tok_peeked;
                next_token();
                struct token *t2 = peek_token();
                if (t2->type == TOK_REDIR_OUT || t2->type == TOK_REDIR_APPEND) {
                    if (n->redir_count >= MAX_REDIRS) break;
                    struct redir *r = &n->redirs[n->redir_count++];
                    r->fd = fd_num;
                    r->dup_fd = -1;
                    r->mode = (t2->type == TOK_REDIR_APPEND)
                        ? (O_WRONLY | O_CREAT | O_APPEND)
                        : (O_WRONLY | O_CREAT | O_TRUNC);
                    next_token();
                    t2 = peek_token();

                    /* Check for &1 style dup */
                    if (t2->type == TOK_WORD && t2->word[0] == '&'
                        && t2->word[1] >= '0' && t2->word[1] <= '9'
                        && t2->word[2] == '\0') {
                        r->dup_fd = t2->word[1] - '0';
                        r->file[0] = '\0';
                        next_token();
                    } else if (t2->type == TOK_WORD) {
                        expand_word(t2->word, r->file, MAX_WORD);
                        next_token();
                    } else {
                        fprintf(stderr, "sh: expected filename after redirect\n");
                    }
                    continue;
                }
                /* Not a redirect — restore and treat as word arg */
                /* We already consumed the token; add it as an arg */
                if (n->argc < MAX_ARGS - 1) {
                    char expanded[MAX_WORD];
                    expand_word(saved.word, expanded, MAX_WORD);
                    n->args[n->argc++] = arena_strdup(expanded);
                }
                /* Now the peek is the next token, which is fine */
                continue;
            }
        }

        /* Check for "2>&1" as a single word */
        if (strlen(t->word) >= 4 && t->word[0] >= '0' && t->word[0] <= '9'
            && t->word[1] == '>' && t->word[2] == '&'
            && t->word[3] >= '0' && t->word[3] <= '9') {
            if (n->redir_count < MAX_REDIRS) {
                struct redir *r = &n->redirs[n->redir_count++];
                r->fd = t->word[0] - '0';
                r->dup_fd = t->word[3] - '0';
                r->mode = 0;
                r->file[0] = '\0';
            }
            next_token();
            continue;
        }

        /* Check for keywords that end command */
        if (is_keyword(t->word))
            break;

        /* Regular word argument */
        if (n->argc < MAX_ARGS - 1) {
            char expanded[MAX_WORD];
            expand_word(t->word, expanded, MAX_WORD);
            n->args[n->argc++] = arena_strdup(expanded);
        }
        next_token();
    }
    n->args[n->argc] = NULL;
    return n;
}

static struct node *parse_if(void);
static struct node *parse_while(void);
static struct node *parse_for(void);

/* command = simple | '{' list '}' | '(' list ')' | if | while | for */
static struct node *parse_command(void) {
    struct token *t = peek_token();

    if (t->type == TOK_WORD && strcmp(t->word, "if") == 0) {
        return parse_if();
    }
    if (t->type == TOK_WORD && strcmp(t->word, "while") == 0) {
        return parse_while();
    }
    if (t->type == TOK_WORD && strcmp(t->word, "for") == 0) {
        return parse_for();
    }
    if (t->type == TOK_LBRACE) {
        next_token();
        struct node *n = alloc_node(NODE_BRACE);
        n->body = parse_list();
        t = peek_token();
        if (t->type == TOK_RBRACE)
            next_token();
        return n;
    }
    if (t->type == TOK_LPAREN) {
        next_token();
        struct node *n = alloc_node(NODE_SUBSHELL);
        n->body = parse_list();
        t = peek_token();
        if (t->type == TOK_RPAREN)
            next_token();
        return n;
    }

    return parse_simple();
}

/* pipeline = command ('|' command)* */
static struct node *parse_pipeline(void) {
    struct node *left = parse_command();

    while (peek_token()->type == TOK_PIPE) {
        next_token(); /* consume | */
        skip_newlines();
        struct node *right = parse_command();
        struct node *pipe = alloc_node(NODE_PIPELINE);
        pipe->left = left;
        pipe->right = right;
        left = pipe;
    }
    return left;
}

/* and_or = pipeline (('&&'|'||') pipeline)* */
static struct node *parse_and_or(void) {
    struct node *left = parse_pipeline();

    while (1) {
        struct token *t = peek_token();
        if (t->type == TOK_AND) {
            next_token();
            skip_newlines();
            struct node *right = parse_pipeline();
            struct node *n = alloc_node(NODE_AND);
            n->left = left;
            n->right = right;
            left = n;
        } else if (t->type == TOK_OR) {
            next_token();
            skip_newlines();
            struct node *right = parse_pipeline();
            struct node *n = alloc_node(NODE_OR);
            n->left = left;
            n->right = right;
            left = n;
        } else {
            break;
        }
    }
    return left;
}

/* list = and_or ((';'|'\n') and_or)* */
static struct node *parse_list(void) {
    skip_newlines();

    struct token *t = peek_token();
    if (t->type == TOK_EOF || t->type == TOK_RBRACE || t->type == TOK_RPAREN)
        return NULL;

    /* Check for fi/done/else/elif which terminate lists */
    if (t->type == TOK_WORD && (strcmp(t->word, "fi") == 0
        || strcmp(t->word, "done") == 0 || strcmp(t->word, "else") == 0
        || strcmp(t->word, "elif") == 0))
        return NULL;

    struct node *left = parse_and_or();

    while (1) {
        t = peek_token();
        if (t->type == TOK_SEMI || t->type == TOK_NEWLINE) {
            next_token();
            skip_newlines();
            t = peek_token();
            if (t->type == TOK_EOF || t->type == TOK_RBRACE
                || t->type == TOK_RPAREN)
                break;
            /* Check for keywords that terminate list */
            if (t->type == TOK_WORD && (strcmp(t->word, "fi") == 0
                || strcmp(t->word, "done") == 0
                || strcmp(t->word, "else") == 0
                || strcmp(t->word, "elif") == 0))
                break;

            struct node *right = parse_and_or();
            struct node *seq = alloc_node(NODE_SEQUENCE);
            seq->left = left;
            seq->right = right;
            left = seq;
        } else {
            break;
        }
    }
    return left;
}

/* if_cmd = 'if' list 'then' list ('elif' list 'then' list)* ['else' list] 'fi' */
static struct node *parse_if(void) {
    next_token(); /* consume 'if' */
    skip_newlines();

    struct node *n = alloc_node(NODE_IF);
    n->left = parse_list();  /* condition */

    /* Expect 'then' */
    struct token *t = peek_token();
    if (t->type == TOK_WORD && strcmp(t->word, "then") == 0)
        next_token();
    skip_newlines();

    n->right = parse_list(); /* then body */

    /* Check for elif / else */
    t = peek_token();
    if (t->type == TOK_WORD && strcmp(t->word, "elif") == 0) {
        /* elif becomes a nested if */
        n->else_part = parse_if();
        return n;  /* the nested parse_if consumed fi */
    }
    if (t->type == TOK_WORD && strcmp(t->word, "else") == 0) {
        next_token();
        skip_newlines();
        n->else_part = parse_list();
    }

    /* Expect 'fi' */
    t = peek_token();
    if (t->type == TOK_WORD && strcmp(t->word, "fi") == 0)
        next_token();

    return n;
}

/* while_cmd = 'while' list 'do' list 'done' */
static struct node *parse_while(void) {
    next_token(); /* consume 'while' */
    skip_newlines();

    struct node *n = alloc_node(NODE_WHILE);
    n->left = parse_list();  /* condition */

    struct token *t = peek_token();
    if (t->type == TOK_WORD && strcmp(t->word, "do") == 0)
        next_token();
    skip_newlines();

    n->right = parse_list(); /* body */

    t = peek_token();
    if (t->type == TOK_WORD && strcmp(t->word, "done") == 0)
        next_token();

    return n;
}

/* for_cmd = 'for' name ['in' words...] ';'|'\n' 'do' list 'done' */
static struct node *parse_for(void) {
    next_token(); /* consume 'for' */

    struct node *n = alloc_node(NODE_FOR);

    struct token *t = peek_token();
    if (t->type == TOK_WORD) {
        strncpy(n->for_var, t->word, 63);
        n->for_var[63] = '\0';
        next_token();
    }

    t = peek_token();
    if (t->type == TOK_WORD && strcmp(t->word, "in") == 0) {
        next_token();
        while (1) {
            t = peek_token();
            if (t->type == TOK_SEMI || t->type == TOK_NEWLINE || t->type == TOK_EOF)
                break;
            if (t->type == TOK_WORD && strcmp(t->word, "do") == 0)
                break;
            if (t->type == TOK_WORD && n->for_word_count < MAX_FOR_WORDS) {
                char expanded[MAX_WORD];
                expand_word(t->word, expanded, MAX_WORD);
                n->for_words[n->for_word_count++] = arena_strdup(expanded);
            }
            next_token();
        }
    }

    /* Skip ; or newline before do */
    if (peek_token()->type == TOK_SEMI || peek_token()->type == TOK_NEWLINE)
        next_token();
    skip_newlines();

    t = peek_token();
    if (t->type == TOK_WORD && strcmp(t->word, "do") == 0)
        next_token();
    skip_newlines();

    n->right = parse_list(); /* body */

    t = peek_token();
    if (t->type == TOK_WORD && strcmp(t->word, "done") == 0)
        next_token();

    return n;
}

/* ================================================================
 * Builtins
 * ================================================================ */

static int builtin_echo(int argc, char **argv) {
    int newline = 1;
    int i = 1;
    if (i < argc && strcmp(argv[i], "-n") == 0) {
        newline = 0;
        i++;
    }
    for (; i < argc; i++) {
        if (i > 1 && !(i == 2 && !newline && strcmp(argv[1], "-n") == 0))
            putchar(' ');
        else if (i > 1)
            putchar(' ');
        fputs(argv[i], stdout);
    }
    if (newline) putchar('\n');
    fflush(stdout);
    return 0;
}

static int builtin_exit(int argc, char **argv) {
    int code = last_status;
    if (argc > 1) code = atoi(argv[1]);
    exit(code);
    return code; /* unreachable */
}

static int builtin_test(int argc, char **argv) {
    /* Remove trailing ] if invoked as [ */
    int count = argc;
    if (count > 0 && strcmp(argv[0], "[") == 0) {
        if (count > 1 && strcmp(argv[count - 1], "]") == 0)
            count--;
    }

    /* No args = false */
    if (count <= 1) return 1;

    int idx = 1;
    int negate = 0;
    if (strcmp(argv[idx], "!") == 0) {
        negate = 1;
        idx++;
        if (idx >= count) return negate ? 0 : 1;
    }

    int result = 1; /* default: false */

    if (idx + 2 < count) {
        /* Binary operators */
        const char *left = argv[idx];
        const char *op = argv[idx + 1];
        const char *right = argv[idx + 2];

        if (strcmp(op, "=") == 0 || strcmp(op, "==") == 0)
            result = (strcmp(left, right) == 0) ? 0 : 1;
        else if (strcmp(op, "!=") == 0)
            result = (strcmp(left, right) != 0) ? 0 : 1;
        else if (strcmp(op, "-eq") == 0)
            result = (atoi(left) == atoi(right)) ? 0 : 1;
        else if (strcmp(op, "-ne") == 0)
            result = (atoi(left) != atoi(right)) ? 0 : 1;
        else if (strcmp(op, "-lt") == 0)
            result = (atoi(left) < atoi(right)) ? 0 : 1;
        else if (strcmp(op, "-le") == 0)
            result = (atoi(left) <= atoi(right)) ? 0 : 1;
        else if (strcmp(op, "-gt") == 0)
            result = (atoi(left) > atoi(right)) ? 0 : 1;
        else if (strcmp(op, "-ge") == 0)
            result = (atoi(left) >= atoi(right)) ? 0 : 1;
    } else if (idx + 1 < count) {
        /* Unary operators */
        const char *op = argv[idx];
        const char *arg = argv[idx + 1];

        if (strcmp(op, "-n") == 0)
            result = (strlen(arg) > 0) ? 0 : 1;
        else if (strcmp(op, "-z") == 0)
            result = (strlen(arg) == 0) ? 0 : 1;
        else if (strcmp(op, "-f") == 0) {
            struct stat st;
            result = (stat(arg, &st) == 0 && S_ISREG(st.st_mode)) ? 0 : 1;
        } else if (strcmp(op, "-d") == 0) {
            struct stat st;
            result = (stat(arg, &st) == 0 && S_ISDIR(st.st_mode)) ? 0 : 1;
        } else if (strcmp(op, "-e") == 0) {
            struct stat st;
            result = (stat(arg, &st) == 0) ? 0 : 1;
        } else if (strcmp(op, "-x") == 0) {
            result = (access(arg, X_OK) == 0) ? 0 : 1;
        } else if (strcmp(op, "-r") == 0) {
            result = (access(arg, R_OK) == 0) ? 0 : 1;
        } else if (strcmp(op, "-w") == 0) {
            result = (access(arg, W_OK) == 0) ? 0 : 1;
        } else if (strcmp(op, "-s") == 0) {
            struct stat st;
            result = (stat(arg, &st) == 0 && st.st_size > 0) ? 0 : 1;
        } else {
            /* Unknown unary op — treat two args as [ str1 = str2 ] without op */
            result = 1;
        }
    } else if (idx < count) {
        /* Single arg: true if non-empty */
        result = (strlen(argv[idx]) > 0) ? 0 : 1;
    }

    return negate ? !result : result;
}

static int builtin_read(int argc, char **argv) {
    if (argc < 2) return 1;
    char line[MAX_WORD];
    if (fgets(line, sizeof(line), stdin) == NULL)
        return 1;
    /* Strip trailing newline */
    int len = strlen(line);
    if (len > 0 && line[len - 1] == '\n')
        line[len - 1] = '\0';
    set_var(argv[1], line);
    return 0;
}

static int builtin_export(int argc, char **argv) {
    for (int i = 1; i < argc; i++) {
        char *eq = strchr(argv[i], '=');
        if (eq) {
            *eq = '\0';
            setenv(argv[i], eq + 1, 1);
            *eq = '=';
        } else {
            /* export existing var */
            const char *val = get_var(argv[i]);
            if (val) setenv(argv[i], val, 1);
        }
    }
    return 0;
}

static int builtin_unset(int argc, char **argv) {
    for (int i = 1; i < argc; i++)
        unset_var(argv[i]);
    return 0;
}

static int builtin_cd(int argc, char **argv) {
    const char *dir = argc > 1 ? argv[1] : getenv("HOME");
    if (!dir) dir = "/";
    if (chdir(dir) != 0) {
        fprintf(stderr, "sh: cd: %s: %s\n", dir, strerror(errno));
        return 1;
    }
    return 0;
}

static int builtin_true(int argc, char **argv) {
    (void)argc; (void)argv;
    return 0;
}

static int builtin_false(int argc, char **argv) {
    (void)argc; (void)argv;
    return 1;
}

static int builtin_kill(int argc, char **argv) {
    int sig = SIGTERM;
    int i = 1;
    if (i < argc && argv[i][0] == '-') {
        const char *s = argv[i] + 1;
        if (strcmp(s, "KILL") == 0 || strcmp(s, "9") == 0) sig = SIGKILL;
        else if (strcmp(s, "TERM") == 0 || strcmp(s, "15") == 0) sig = SIGTERM;
        else if (strcmp(s, "HUP") == 0 || strcmp(s, "1") == 0) sig = SIGHUP;
        else if (strcmp(s, "INT") == 0 || strcmp(s, "2") == 0) sig = SIGINT;
        else if (strcmp(s, "QUIT") == 0 || strcmp(s, "3") == 0) sig = SIGQUIT;
        else if (strcmp(s, "ABRT") == 0 || strcmp(s, "6") == 0) sig = SIGABRT;
        else if (strcmp(s, "USR1") == 0 || strcmp(s, "10") == 0) sig = SIGUSR1;
        else if (strcmp(s, "USR2") == 0 || strcmp(s, "12") == 0) sig = SIGUSR2;
        else sig = atoi(s);
        i++;
    }
    for (; i < argc; i++) {
        pid_t pid = atoi(argv[i]);
        if (kill(pid, sig) != 0) {
            fprintf(stderr, "sh: kill: (%d) - %s\n", pid, strerror(errno));
            return 1;
        }
    }
    return 0;
}

struct builtin_entry {
    const char *name;
    int (*fn)(int, char **);
};

static struct builtin_entry builtins[] = {
    { "echo",   builtin_echo },
    { "exit",   builtin_exit },
    { "test",   builtin_test },
    { "[",      builtin_test },
    { "read",   builtin_read },
    { "export", builtin_export },
    { "unset",  builtin_unset },
    { "cd",     builtin_cd },
    { "true",   builtin_true },
    { ":",      builtin_true },
    { "false",  builtin_false },
    { "kill",   builtin_kill },
    { NULL, NULL }
};

static int (*find_builtin(const char *name))(int, char **) {
    for (int i = 0; builtins[i].name; i++) {
        if (strcmp(builtins[i].name, name) == 0)
            return builtins[i].fn;
    }
    return NULL;
}

/* ================================================================
 * Execution engine
 * ================================================================ */

static int run_node(struct node *n);

static void apply_redirects(struct redir *redirs, int count) {
    for (int i = 0; i < count; i++) {
        struct redir *r = &redirs[i];
        if (r->dup_fd >= 0) {
            dup2(r->dup_fd, r->fd);
        } else {
            int fd = open(r->file, r->mode, 0666);
            if (fd < 0) {
                fprintf(stderr, "sh: %s: %s\n", r->file, strerror(errno));
                _exit(1);
            }
            if (fd != r->fd) {
                dup2(fd, r->fd);
                close(fd);
            }
        }
    }
}

/* Check if args contain an assignment (VAR=value with no command) */
static int is_assignment(const char *word) {
    if (!word || !isalpha(word[0]) && word[0] != '_')
        return 0;
    const char *p = word;
    while (isalnum(*p) || *p == '_') p++;
    return *p == '=';
}

static int run_simple(struct node *n) {
    if (n->argc == 0) {
        /* Just redirections or empty */
        if (n->redir_count > 0) {
            apply_redirects(n->redirs, n->redir_count);
        }
        return 0;
    }

    /* Handle assignments: VAR=value */
    if (is_assignment(n->args[0]) && n->argc == 1) {
        char *eq = strchr(n->args[0], '=');
        *eq = '\0';
        set_var(n->args[0], eq + 1);
        *eq = '=';
        return 0;
    }

    /* Check for builtin */
    int (*builtin)(int, char **) = find_builtin(n->args[0]);
    if (builtin) {
        /* For builtins with redirections, save/restore fds */
        int saved_fds[MAX_REDIRS][2]; /* [i][0]=orig_fd, [i][1]=saved_copy */
        int saved_count = 0;
        for (int i = 0; i < n->redir_count; i++) {
            struct redir *r = &n->redirs[i];
            saved_fds[saved_count][0] = r->fd;
            saved_fds[saved_count][1] = dup(r->fd);
            saved_count++;
        }
        apply_redirects(n->redirs, n->redir_count);
        int rc = builtin(n->argc, n->args);
        /* Restore */
        for (int i = 0; i < saved_count; i++) {
            dup2(saved_fds[i][1], saved_fds[i][0]);
            close(saved_fds[i][1]);
        }
        return rc;
    }

    /* External command: fork + exec */
    pid_t pid = fork();
    if (pid < 0) {
        fprintf(stderr, "sh: fork: %s\n", strerror(errno));
        return 127;
    }
    if (pid == 0) {
        /* Child */
        apply_redirects(n->redirs, n->redir_count);
        execvp(n->args[0], n->args);
        fprintf(stderr, "sh: %s: %s\n", n->args[0], strerror(errno));
        _exit(127);
    }
    /* Parent */
    int status;
    waitpid(pid, &status, 0);
    if (WIFEXITED(status))
        return WEXITSTATUS(status);
    if (WIFSIGNALED(status))
        return 128 + WTERMSIG(status);
    return 1;
}

static int run_pipeline(struct node *n) {
    int pipefd[2];
    if (pipe(pipefd) < 0) {
        fprintf(stderr, "sh: pipe: %s\n", strerror(errno));
        return 1;
    }

    pid_t left_pid = fork();
    if (left_pid < 0) {
        close(pipefd[0]);
        close(pipefd[1]);
        return 1;
    }
    if (left_pid == 0) {
        /* Left child: stdout → pipe write */
        close(pipefd[0]);
        dup2(pipefd[1], STDOUT_FILENO);
        close(pipefd[1]);
        _exit(run_node(n->left));
    }

    pid_t right_pid = fork();
    if (right_pid < 0) {
        close(pipefd[0]);
        close(pipefd[1]);
        waitpid(left_pid, NULL, 0);
        return 1;
    }
    if (right_pid == 0) {
        /* Right child: stdin ← pipe read */
        close(pipefd[1]);
        dup2(pipefd[0], STDIN_FILENO);
        close(pipefd[0]);
        _exit(run_node(n->right));
    }

    close(pipefd[0]);
    close(pipefd[1]);

    int status;
    waitpid(left_pid, &status, 0);
    waitpid(right_pid, &status, 0);

    if (WIFEXITED(status))
        return WEXITSTATUS(status);
    if (WIFSIGNALED(status))
        return 128 + WTERMSIG(status);
    return 1;
}

static int run_node(struct node *n) {
    if (!n) return 0;

    switch (n->type) {
    case NODE_SIMPLE:
        return run_simple(n);

    case NODE_PIPELINE:
        return run_pipeline(n);

    case NODE_AND: {
        int rc = run_node(n->left);
        last_status = rc;
        if (rc == 0)
            return run_node(n->right);
        return rc;
    }

    case NODE_OR: {
        int rc = run_node(n->left);
        last_status = rc;
        if (rc != 0)
            return run_node(n->right);
        return rc;
    }

    case NODE_SEQUENCE: {
        int rc = run_node(n->left);
        last_status = rc;
        return run_node(n->right);
    }

    case NODE_BRACE:
        return run_node(n->body);

    case NODE_SUBSHELL: {
        pid_t pid = fork();
        if (pid < 0) return 1;
        if (pid == 0)
            _exit(run_node(n->body));
        int status;
        waitpid(pid, &status, 0);
        if (WIFEXITED(status))
            return WEXITSTATUS(status);
        if (WIFSIGNALED(status))
            return 128 + WTERMSIG(status);
        return 1;
    }

    case NODE_IF: {
        int cond = run_node(n->left);
        last_status = cond;
        if (cond == 0)
            return run_node(n->right);
        if (n->else_part)
            return run_node(n->else_part);
        return 0;
    }

    case NODE_WHILE: {
        int rc = 0;
        while (1) {
            int cond = run_node(n->left);
            last_status = cond;
            if (cond != 0) break;
            rc = run_node(n->right);
            last_status = rc;
        }
        return rc;
    }

    case NODE_FOR: {
        int rc = 0;
        for (int i = 0; i < n->for_word_count; i++) {
            set_var(n->for_var, n->for_words[i]);
            rc = run_node(n->right);
            last_status = rc;
        }
        return rc;
    }

    default:
        return 1;
    }
}

/* ================================================================
 * Main — run a command string
 * ================================================================ */

static int run_string(const char *input) {
    /* Reset parser state */
    tok_pos = input;
    tok_peeked = 0;
    node_next = 0;
    string_next = 0;

    struct node *ast = parse_list();
    if (!ast) return last_status;

    int rc = run_node(ast);
    last_status = rc;
    return rc;
}

int main(int argc, char **argv) {
    if (argc > 0)
        shell_argv0 = argv[0];

    /* sh -c "command" mode */
    if (argc >= 3 && strcmp(argv[1], "-c") == 0) {
        return run_string(argv[2]);
    }

    /* stdin mode (for popen, etc.) */
    char line[MAX_LINE];
    int rc = 0;
    while (fgets(line, sizeof(line), stdin) != NULL) {
        /* Strip trailing newline */
        int len = strlen(line);
        if (len > 0 && line[len - 1] == '\n')
            line[len - 1] = '\0';
        if (line[0] == '\0') continue;
        rc = run_string(line);
    }
    return rc;
}
