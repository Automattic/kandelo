/* A Bison parser, made by GNU Bison 3.0.2.  */

/* Bison implementation for Yacc-like parsers in C

   Copyright (C) 1984, 1989-1990, 2000-2013 Free Software Foundation, Inc.

   This program is free software: you can redistribute it and/or modify
   it under the terms of the GNU General Public License as published by
   the Free Software Foundation, either version 3 of the License, or
   (at your option) any later version.

   This program is distributed in the hope that it will be useful,
   but WITHOUT ANY WARRANTY; without even the implied warranty of
   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
   GNU General Public License for more details.

   You should have received a copy of the GNU General Public License
   along with this program.  If not, see <http://www.gnu.org/licenses/>.  */

/* As a special exception, you may create a larger work that contains
   part or all of the Bison parser skeleton and distribute that work
   under terms of your choice, so long as that work isn't itself a
   parser generator using the skeleton or a modified version thereof
   as a parser skeleton.  Alternatively, if you modify or redistribute
   the parser skeleton itself, you may (at your option) remove this
   special exception, which will cause the skeleton and the resulting
   Bison output files to be licensed under the GNU General Public
   License without this special exception.

   This special exception was added by the Free Software Foundation in
   version 2.2 of Bison.  */

/* C LALR(1) parser skeleton written by Richard Stallman, by
   simplifying the original so-called "semantic" parser.  */

/* All symbols defined below should begin with yy or YY, to avoid
   infringing on user name space.  This should be done even for local
   variables, as they might otherwise be expanded by user macros.
   There are some unavoidable exceptions within include files to
   define necessary library symbols; they are noted "INFRINGES ON
   USER NAME SPACE" below.  */

/* Identify Bison output.  */
#define YYBISON 1

/* Bison version.  */
#define YYBISON_VERSION "3.0.2"

/* Skeleton name.  */
#define YYSKELETON_NAME "yacc.c"

/* Pure parsers.  */
#define YYPURE 0

/* Push parsers.  */
#define YYPUSH 0

/* Pull parsers.  */
#define YYPULL 1




/* Copy the first part of user declarations.  */
#line 31 "../../bc/bc.y" /* yacc.c:339  */


#include "bcdefs.h"
#include "global.h"
#include "proto.h"

/* current function number. */
int cur_func = -1;

/* Expression encoded information -- See comment at expression rules. */
#define EX_ASSGN 0 
#define EX_REG   1
#define EX_COMP  2
#define EX_PAREN 4
#define EX_VOID  8 
#define EX_EMPTY 16


#line 85 "bc.c" /* yacc.c:339  */

# ifndef YY_NULLPTR
#  if defined __cplusplus && 201103L <= __cplusplus
#   define YY_NULLPTR nullptr
#  else
#   define YY_NULLPTR 0
#  endif
# endif

/* Enabling verbose error messages.  */
#ifdef YYERROR_VERBOSE
# undef YYERROR_VERBOSE
# define YYERROR_VERBOSE 1
#else
# define YYERROR_VERBOSE 0
#endif

/* In a future release of Bison, this section will be replaced
   by #include "y.tab.h".  */
#ifndef YY_YY_BC_H_INCLUDED
# define YY_YY_BC_H_INCLUDED
/* Debug traces.  */
#ifndef YYDEBUG
# define YYDEBUG 0
#endif
#if YYDEBUG
extern int yydebug;
#endif

/* Token type.  */
#ifndef YYTOKENTYPE
# define YYTOKENTYPE
  enum yytokentype
  {
    ENDOFLINE = 258,
    AND = 259,
    OR = 260,
    NOT = 261,
    STRING = 262,
    NAME = 263,
    NUMBER = 264,
    ASSIGN_OP = 265,
    REL_OP = 266,
    INCR_DECR = 267,
    Define = 268,
    Break = 269,
    Quit = 270,
    Length = 271,
    Return = 272,
    For = 273,
    If = 274,
    While = 275,
    Sqrt = 276,
    Else = 277,
    Scale = 278,
    Ibase = 279,
    Obase = 280,
    Auto = 281,
    Read = 282,
    Random = 283,
    Warranty = 284,
    Halt = 285,
    Last = 286,
    Continue = 287,
    Print = 288,
    Limits = 289,
    UNARY_MINUS = 290,
    HistoryVar = 291,
    Void = 292
  };
#endif
/* Tokens.  */
#define ENDOFLINE 258
#define AND 259
#define OR 260
#define NOT 261
#define STRING 262
#define NAME 263
#define NUMBER 264
#define ASSIGN_OP 265
#define REL_OP 266
#define INCR_DECR 267
#define Define 268
#define Break 269
#define Quit 270
#define Length 271
#define Return 272
#define For 273
#define If 274
#define While 275
#define Sqrt 276
#define Else 277
#define Scale 278
#define Ibase 279
#define Obase 280
#define Auto 281
#define Read 282
#define Random 283
#define Warranty 284
#define Halt 285
#define Last 286
#define Continue 287
#define Print 288
#define Limits 289
#define UNARY_MINUS 290
#define HistoryVar 291
#define Void 292

/* Value type.  */
#if ! defined YYSTYPE && ! defined YYSTYPE_IS_DECLARED
typedef union YYSTYPE YYSTYPE;
union YYSTYPE
{
#line 52 "../../bc/bc.y" /* yacc.c:355  */

	char	 *s_value;
	char	  c_value;
	int	  i_value;
	arg_list *a_value;
       

#line 207 "bc.c" /* yacc.c:355  */
};
# define YYSTYPE_IS_TRIVIAL 1
# define YYSTYPE_IS_DECLARED 1
#endif


extern YYSTYPE yylval;

int yyparse (void);

#endif /* !YY_YY_BC_H_INCLUDED  */

/* Copy the second part of user declarations.  */

#line 222 "bc.c" /* yacc.c:358  */

#ifdef short
# undef short
#endif

#ifdef YYTYPE_UINT8
typedef YYTYPE_UINT8 yytype_uint8;
#else
typedef unsigned char yytype_uint8;
#endif

#ifdef YYTYPE_INT8
typedef YYTYPE_INT8 yytype_int8;
#else
typedef signed char yytype_int8;
#endif

#ifdef YYTYPE_UINT16
typedef YYTYPE_UINT16 yytype_uint16;
#else
typedef unsigned short int yytype_uint16;
#endif

#ifdef YYTYPE_INT16
typedef YYTYPE_INT16 yytype_int16;
#else
typedef short int yytype_int16;
#endif

#ifndef YYSIZE_T
# ifdef __SIZE_TYPE__
#  define YYSIZE_T __SIZE_TYPE__
# elif defined size_t
#  define YYSIZE_T size_t
# elif ! defined YYSIZE_T
#  include <stddef.h> /* INFRINGES ON USER NAME SPACE */
#  define YYSIZE_T size_t
# else
#  define YYSIZE_T unsigned int
# endif
#endif

#define YYSIZE_MAXIMUM ((YYSIZE_T) -1)

#ifndef YY_
# if defined YYENABLE_NLS && YYENABLE_NLS
#  if ENABLE_NLS
#   include <libintl.h> /* INFRINGES ON USER NAME SPACE */
#   define YY_(Msgid) dgettext ("bison-runtime", Msgid)
#  endif
# endif
# ifndef YY_
#  define YY_(Msgid) Msgid
# endif
#endif

#ifndef YY_ATTRIBUTE
# if (defined __GNUC__                                               \
      && (2 < __GNUC__ || (__GNUC__ == 2 && 96 <= __GNUC_MINOR__)))  \
     || defined __SUNPRO_C && 0x5110 <= __SUNPRO_C
#  define YY_ATTRIBUTE(Spec) __attribute__(Spec)
# else
#  define YY_ATTRIBUTE(Spec) /* empty */
# endif
#endif

#ifndef YY_ATTRIBUTE_PURE
# define YY_ATTRIBUTE_PURE   YY_ATTRIBUTE ((__pure__))
#endif

#ifndef YY_ATTRIBUTE_UNUSED
# define YY_ATTRIBUTE_UNUSED YY_ATTRIBUTE ((__unused__))
#endif

#if !defined _Noreturn \
     && (!defined __STDC_VERSION__ || __STDC_VERSION__ < 201112)
# if defined _MSC_VER && 1200 <= _MSC_VER
#  define _Noreturn __declspec (noreturn)
# else
#  define _Noreturn YY_ATTRIBUTE ((__noreturn__))
# endif
#endif

/* Suppress unused-variable warnings by "using" E.  */
#if ! defined lint || defined __GNUC__
# define YYUSE(E) ((void) (E))
#else
# define YYUSE(E) /* empty */
#endif

#if defined __GNUC__ && 407 <= __GNUC__ * 100 + __GNUC_MINOR__
/* Suppress an incorrect diagnostic about yylval being uninitialized.  */
# define YY_IGNORE_MAYBE_UNINITIALIZED_BEGIN \
    _Pragma ("GCC diagnostic push") \
    _Pragma ("GCC diagnostic ignored \"-Wuninitialized\"")\
    _Pragma ("GCC diagnostic ignored \"-Wmaybe-uninitialized\"")
# define YY_IGNORE_MAYBE_UNINITIALIZED_END \
    _Pragma ("GCC diagnostic pop")
#else
# define YY_INITIAL_VALUE(Value) Value
#endif
#ifndef YY_IGNORE_MAYBE_UNINITIALIZED_BEGIN
# define YY_IGNORE_MAYBE_UNINITIALIZED_BEGIN
# define YY_IGNORE_MAYBE_UNINITIALIZED_END
#endif
#ifndef YY_INITIAL_VALUE
# define YY_INITIAL_VALUE(Value) /* Nothing. */
#endif


#if ! defined yyoverflow || YYERROR_VERBOSE

/* The parser invokes alloca or malloc; define the necessary symbols.  */

# ifdef YYSTACK_USE_ALLOCA
#  if YYSTACK_USE_ALLOCA
#   ifdef __GNUC__
#    define YYSTACK_ALLOC __builtin_alloca
#   elif defined __BUILTIN_VA_ARG_INCR
#    include <alloca.h> /* INFRINGES ON USER NAME SPACE */
#   elif defined _AIX
#    define YYSTACK_ALLOC __alloca
#   elif defined _MSC_VER
#    include <malloc.h> /* INFRINGES ON USER NAME SPACE */
#    define alloca _alloca
#   else
#    define YYSTACK_ALLOC alloca
#    if ! defined _ALLOCA_H && ! defined EXIT_SUCCESS
#     include <stdlib.h> /* INFRINGES ON USER NAME SPACE */
      /* Use EXIT_SUCCESS as a witness for stdlib.h.  */
#     ifndef EXIT_SUCCESS
#      define EXIT_SUCCESS 0
#     endif
#    endif
#   endif
#  endif
# endif

# ifdef YYSTACK_ALLOC
   /* Pacify GCC's 'empty if-body' warning.  */
#  define YYSTACK_FREE(Ptr) do { /* empty */; } while (0)
#  ifndef YYSTACK_ALLOC_MAXIMUM
    /* The OS might guarantee only one guard page at the bottom of the stack,
       and a page size can be as small as 4096 bytes.  So we cannot safely
       invoke alloca (N) if N exceeds 4096.  Use a slightly smaller number
       to allow for a few compiler-allocated temporary stack slots.  */
#   define YYSTACK_ALLOC_MAXIMUM 4032 /* reasonable circa 2006 */
#  endif
# else
#  define YYSTACK_ALLOC YYMALLOC
#  define YYSTACK_FREE YYFREE
#  ifndef YYSTACK_ALLOC_MAXIMUM
#   define YYSTACK_ALLOC_MAXIMUM YYSIZE_MAXIMUM
#  endif
#  if (defined __cplusplus && ! defined EXIT_SUCCESS \
       && ! ((defined YYMALLOC || defined malloc) \
             && (defined YYFREE || defined free)))
#   include <stdlib.h> /* INFRINGES ON USER NAME SPACE */
#   ifndef EXIT_SUCCESS
#    define EXIT_SUCCESS 0
#   endif
#  endif
#  ifndef YYMALLOC
#   define YYMALLOC malloc
#   if ! defined malloc && ! defined EXIT_SUCCESS
void *malloc (YYSIZE_T); /* INFRINGES ON USER NAME SPACE */
#   endif
#  endif
#  ifndef YYFREE
#   define YYFREE free
#   if ! defined free && ! defined EXIT_SUCCESS
void free (void *); /* INFRINGES ON USER NAME SPACE */
#   endif
#  endif
# endif
#endif /* ! defined yyoverflow || YYERROR_VERBOSE */


#if (! defined yyoverflow \
     && (! defined __cplusplus \
         || (defined YYSTYPE_IS_TRIVIAL && YYSTYPE_IS_TRIVIAL)))

/* A type that is properly aligned for any stack member.  */
union yyalloc
{
  yytype_int16 yyss_alloc;
  YYSTYPE yyvs_alloc;
};

/* The size of the maximum gap between one aligned stack and the next.  */
# define YYSTACK_GAP_MAXIMUM (sizeof (union yyalloc) - 1)

/* The size of an array large to enough to hold all stacks, each with
   N elements.  */
# define YYSTACK_BYTES(N) \
     ((N) * (sizeof (yytype_int16) + sizeof (YYSTYPE)) \
      + YYSTACK_GAP_MAXIMUM)

# define YYCOPY_NEEDED 1

/* Relocate STACK from its old location to the new one.  The
   local variables YYSIZE and YYSTACKSIZE give the old and new number of
   elements in the stack, and YYPTR gives the new location of the
   stack.  Advance YYPTR to a properly aligned location for the next
   stack.  */
# define YYSTACK_RELOCATE(Stack_alloc, Stack)                           \
    do                                                                  \
      {                                                                 \
        YYSIZE_T yynewbytes;                                            \
        YYCOPY (&yyptr->Stack_alloc, Stack, yysize);                    \
        Stack = &yyptr->Stack_alloc;                                    \
        yynewbytes = yystacksize * sizeof (*Stack) + YYSTACK_GAP_MAXIMUM; \
        yyptr += yynewbytes / sizeof (*yyptr);                          \
      }                                                                 \
    while (0)

#endif

#if defined YYCOPY_NEEDED && YYCOPY_NEEDED
/* Copy COUNT objects from SRC to DST.  The source and destination do
   not overlap.  */
# ifndef YYCOPY
#  if defined __GNUC__ && 1 < __GNUC__
#   define YYCOPY(Dst, Src, Count) \
      __builtin_memcpy (Dst, Src, (Count) * sizeof (*(Src)))
#  else
#   define YYCOPY(Dst, Src, Count)              \
      do                                        \
        {                                       \
          YYSIZE_T yyi;                         \
          for (yyi = 0; yyi < (Count); yyi++)   \
            (Dst)[yyi] = (Src)[yyi];            \
        }                                       \
      while (0)
#  endif
# endif
#endif /* !YYCOPY_NEEDED */

/* YYFINAL -- State number of the termination state.  */
#define YYFINAL  2
/* YYLAST -- Last index in YYTABLE.  */
#define YYLAST   719

/* YYNTOKENS -- Number of terminals.  */
#define YYNTOKENS  53
/* YYNNTS -- Number of nonterminals.  */
#define YYNNTS  36
/* YYNRULES -- Number of rules.  */
#define YYNRULES  112
/* YYNSTATES -- Number of states.  */
#define YYNSTATES  198

/* YYTRANSLATE[YYX] -- Symbol number corresponding to YYX as returned
   by yylex, with out-of-bounds checking.  */
#define YYUNDEFTOK  2
#define YYMAXUTOK   292

#define YYTRANSLATE(YYX)                                                \
  ((unsigned int) (YYX) <= YYMAXUTOK ? yytranslate[YYX] : YYUNDEFTOK)

/* YYTRANSLATE[TOKEN-NUM] -- Symbol number corresponding to TOKEN-NUM
   as returned by yylex, without out-of-bounds checking.  */
static const yytype_uint8 yytranslate[] =
{
       0,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,    42,    52,     2,
      45,    46,    40,    38,    49,    39,     2,    41,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,    44,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,    50,     2,    51,    43,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,    47,     2,    48,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     1,     2,     3,     4,
       5,     6,     7,     8,     9,    10,    11,    12,    13,    14,
      15,    16,    17,    18,    19,    20,    21,    22,    23,    24,
      25,    26,    27,    28,    29,    30,    31,    32,    33,    34,
      35,    36,    37
};

#if YYDEBUG
  /* YYRLINE[YYN] -- Source line where rule number YYN was defined.  */
static const yytype_uint16 yyrline[] =
{
       0,   123,   123,   131,   133,   135,   137,   143,   144,   148,
     149,   150,   151,   154,   155,   156,   157,   158,   159,   161,
     162,   165,   167,   169,   178,   185,   196,   208,   210,   212,
     215,   220,   232,   247,   214,   267,   266,   282,   290,   281,
     306,   309,   308,   312,   313,   315,   321,   328,   330,   329,
     342,   340,   367,   368,   375,   376,   379,   380,   382,   385,
     387,   389,   393,   397,   399,   401,   405,   411,   412,   414,
     422,   429,   437,   456,   460,   463,   469,   484,   483,   513,
     512,   528,   527,   545,   553,   584,   591,   598,   605,   612,
     619,   626,   633,   642,   658,   664,   684,   703,   726,   733,
     740,   747,   753,   760,   762,   770,   772,   774,   776,   780,
     787,   788,   789
};
#endif

#if YYDEBUG || YYERROR_VERBOSE || 0
/* YYTNAME[SYMBOL-NUM] -- String name of the symbol SYMBOL-NUM.
   First, the terminals, then, starting at YYNTOKENS, nonterminals.  */
static const char *const yytname[] =
{
  "$end", "error", "$undefined", "ENDOFLINE", "AND", "OR", "NOT",
  "STRING", "NAME", "NUMBER", "ASSIGN_OP", "REL_OP", "INCR_DECR", "Define",
  "Break", "Quit", "Length", "Return", "For", "If", "While", "Sqrt",
  "Else", "Scale", "Ibase", "Obase", "Auto", "Read", "Random", "Warranty",
  "Halt", "Last", "Continue", "Print", "Limits", "UNARY_MINUS",
  "HistoryVar", "Void", "'+'", "'-'", "'*'", "'/'", "'%'", "'^'", "';'",
  "'('", "')'", "'{'", "'}'", "','", "'['", "']'", "'&'", "$accept",
  "program", "input_item", "opt_newline", "semicolon_list",
  "statement_list", "statement_or_error", "statement", "$@1", "$@2", "@3",
  "$@4", "$@5", "$@6", "$@7", "$@8", "print_list", "print_element",
  "opt_else", "$@9", "function", "$@10", "opt_void", "opt_parameter_list",
  "opt_auto_define_list", "define_list", "opt_argument_list",
  "argument_list", "opt_expression", "return_expression", "expression",
  "$@11", "$@12", "$@13", "named_expression", "required_eol", YY_NULLPTR
};
#endif

# ifdef YYPRINT
/* YYTOKNUM[NUM] -- (External) token number corresponding to the
   (internal) symbol number NUM (which must be that of a token).  */
static const yytype_uint16 yytoknum[] =
{
       0,   256,   257,   258,   259,   260,   261,   262,   263,   264,
     265,   266,   267,   268,   269,   270,   271,   272,   273,   274,
     275,   276,   277,   278,   279,   280,   281,   282,   283,   284,
     285,   286,   287,   288,   289,   290,   291,   292,    43,    45,
      42,    47,    37,    94,    59,    40,    41,   123,   125,    44,
      91,    93,    38
};
# endif

#define YYPACT_NINF -144

#define yypact_value_is_default(Yystate) \
  (!!((Yystate) == (-144)))

#define YYTABLE_NINF -16

#define yytable_value_is_error(Yytable_value) \
  0

  /* YYPACT[STATE-NUM] -- Index in YYTABLE of the portion describing
     STATE-NUM.  */
static const yytype_int16 yypact[] =
{
    -144,   188,  -144,   392,   595,  -144,   -36,  -144,   484,   -31,
    -144,  -144,   -32,   595,  -144,   -11,  -144,   -10,    -7,  -144,
    -144,    -6,    -5,  -144,  -144,  -144,  -144,  -144,  -144,  -144,
     595,   595,   222,  -144,     2,  -144,  -144,  -144,   676,    14,
    -144,  -144,   131,   621,   595,   -27,  -144,  -144,  -144,    54,
     595,  -144,   676,    20,   595,    21,   595,   595,    13,    37,
     569,  -144,   425,   535,     1,  -144,  -144,   318,  -144,  -144,
     595,   595,   595,   595,   595,   595,   595,  -144,  -144,   -23,
      41,    36,   676,    39,    43,   436,   595,   445,   595,   485,
     494,  -144,  -144,  -144,  -144,    40,   676,  -144,   270,   535,
    -144,  -144,   595,   595,   -22,    51,    51,     4,     4,     4,
       4,   595,   105,  -144,   647,  -144,    23,  -144,    53,   676,
    -144,   676,  -144,  -144,   569,  -144,  -144,   131,   123,   -22,
    -144,   -20,   676,    45,    91,    94,    57,    55,  -144,   102,
      60,  -144,   352,    56,    58,    65,   102,    24,   595,  -144,
     535,   102,  -144,  -144,    67,    68,    69,    70,   115,   116,
      81,   109,   535,  -144,  -144,   132,    86,    88,    89,  -144,
    -144,  -144,  -144,  -144,     7,  -144,    92,    97,   595,   102,
    -144,    23,  -144,  -144,  -144,    99,   535,    12,   222,  -144,
    -144,  -144,  -144,     9,   102,  -144,   535,  -144
};

  /* YYDEFACT[STATE-NUM] -- Default reduction number in state STATE-NUM.
     Performed when YYTABLE does not specify something else to do.  Zero
     means the default is an error.  */
static const yytype_uint8 yydefact[] =
{
       2,     0,     1,     0,     0,    24,   103,    93,     0,    52,
      25,    27,     0,    75,    30,     0,    37,     0,   107,   105,
     106,     0,     0,    21,    28,   109,    26,    41,    22,   108,
       0,     0,     0,     3,     0,    10,    19,     5,    23,    92,
       6,    20,    83,    67,     0,   103,   107,    96,    53,     0,
       0,    29,    76,     0,     0,     0,     0,     0,     0,     0,
       0,    91,     0,     0,     0,    14,     4,     0,    79,    81,
       0,     0,     0,     0,     0,     0,     0,    77,    97,   103,
       0,    68,    69,     0,     0,     0,    73,     0,     0,     0,
       0,   101,   102,    45,    42,    43,    46,    94,     0,    17,
      40,    11,     0,     0,    84,    85,    86,    87,    88,    89,
      90,     0,     0,    95,     0,   104,    54,    98,     0,    74,
      35,    38,    99,   100,     0,    16,    18,    80,    82,    78,
      70,   103,    71,    59,     0,     0,     0,    55,    31,     7,
       0,    44,     0,     0,     0,     0,     7,     0,    73,     8,
       0,     7,    72,    60,     0,     0,     0,    63,     0,     0,
       0,    47,     0,    61,    62,   110,     0,     0,     0,    32,
      48,    36,    39,   111,    56,    64,     0,     0,    73,     7,
     112,     0,    50,    65,    66,     0,     0,     0,     0,    33,
      49,    57,    58,     0,     7,    51,     0,    34
};

  /* YYPGOTO[NTERM-NUM].  */
static const yytype_int16 yypgoto[] =
{
    -144,  -144,  -144,  -143,  -144,   -39,     0,    -3,  -144,  -144,
    -144,  -144,  -144,  -144,  -144,  -144,    27,  -144,  -144,  -144,
    -144,  -144,  -144,  -144,  -144,   -29,  -144,  -144,  -141,  -144,
      -2,  -144,  -144,  -144,   145,  -144
};

  /* YYDEFGOTO[NTERM-NUM].  */
static const yytype_int16 yydefgoto[] =
{
      -1,     1,    33,   150,    34,    64,    65,    36,    53,   148,
     178,   194,   139,    55,   140,    60,    94,    95,   171,   179,
      37,   188,    49,   136,   182,   137,    80,    81,   118,    51,
      38,   111,   102,   103,    39,   174
};

  /* YYTABLE[YYPACT[STATE-NUM]] -- What to do in state STATE-NUM.  If
     positive, shift that token.  If negative, reduce the rule whose
     number is the opposite.  If YYTABLE_NINF, syntax error.  */
static const yytype_int16 yytable[] =
{
      41,    35,    42,   156,    98,    66,    48,   160,   162,    43,
     180,    52,    98,    50,    44,   191,    71,    72,    73,    74,
      75,    76,    43,    44,    77,    43,    78,   112,    61,    62,
     142,   133,   157,   181,    54,    56,   186,   185,    57,    58,
      59,    82,    83,    68,    69,    99,    67,    76,    85,   100,
      70,   196,    87,    99,    89,    90,   192,   195,    96,    91,
      41,   147,    84,   134,   158,    86,    88,   101,   104,   105,
     106,   107,   108,   109,   110,   135,   159,    71,    72,    73,
      74,    75,    76,    92,   119,   114,   121,   113,   116,   124,
     115,    73,    74,    75,    76,   143,   126,   138,   125,   144,
     127,   128,   145,   146,   147,   149,   151,   153,   154,   129,
      83,     4,   132,     6,     7,   155,   165,     8,   163,   164,
     166,    12,    96,   167,   168,   169,    17,    68,    18,    19,
      20,   170,    21,    22,    70,   173,    25,   175,   176,   177,
      83,    29,    70,   183,    30,   189,   119,   161,   184,   193,
      31,   141,   187,    47,     0,     0,   130,     0,     0,   172,
       0,    71,    72,    73,    74,    75,    76,     0,     0,    71,
      72,    73,    74,    75,    76,     0,   119,     0,     0,     0,
       0,     0,     0,   190,     0,     0,     0,     0,     2,     3,
       0,    -9,     0,   197,     4,     5,     6,     7,     0,     0,
       8,     9,    10,    11,    12,    13,    14,    15,    16,    17,
       0,    18,    19,    20,     0,    21,    22,    23,    24,    25,
      26,    27,    28,    63,    29,   -13,     0,    30,     4,     5,
       6,     7,    -9,    31,     8,    32,    10,    11,    12,    13,
      14,    15,    16,    17,     0,    18,    19,    20,     0,    21,
      22,    23,    24,    25,    26,    27,    28,     0,    29,     0,
       0,    30,     0,     0,     0,     0,   -13,    31,     0,    32,
     -13,    63,     0,   -15,     0,     0,     4,     5,     6,     7,
       0,     0,     8,     0,    10,    11,    12,    13,    14,    15,
      16,    17,     0,    18,    19,    20,     0,    21,    22,    23,
      24,    25,    26,    27,    28,     0,    29,     0,     0,    30,
       0,     0,     0,     0,   -15,    31,     0,    32,   -15,    63,
       0,   -12,     0,     0,     4,     5,     6,     7,     0,     0,
       8,     0,    10,    11,    12,    13,    14,    15,    16,    17,
       0,    18,    19,    20,     0,    21,    22,    23,    24,    25,
      26,    27,    28,     0,    29,     0,     0,    30,     4,     0,
       6,     7,   -12,    31,     8,    32,     0,     0,    12,     0,
       0,     0,     0,    17,     0,    18,    19,    20,     0,    21,
      22,     0,     0,    25,     0,     0,     0,     0,    29,     0,
       0,    30,     0,     0,     0,    40,     0,    31,     4,     5,
       6,     7,     0,   152,     8,     0,    10,    11,    12,    13,
      14,    15,    16,    17,     0,    18,    19,    20,     0,    21,
      22,    23,    24,    25,    26,    27,    28,     0,    29,    68,
      69,    30,     0,     0,     0,     0,    70,    31,     0,    32,
      68,    69,     0,     0,     0,     0,     0,    70,     0,    68,
      69,     0,     0,     0,     0,     0,    70,     0,     0,     0,
       0,     0,     0,    71,    72,    73,    74,    75,    76,     0,
       0,    97,     0,     0,    71,    72,    73,    74,    75,    76,
       0,     0,   117,    71,    72,    73,    74,    75,    76,    68,
      69,   120,    45,     0,     0,     0,    70,     0,    68,    69,
       0,     0,     0,     0,     0,    70,     0,    46,    19,    20,
       0,     0,     0,     0,     0,    25,     0,     0,     0,     0,
      29,     0,     0,    71,    72,    73,    74,    75,    76,     0,
       0,   122,    71,    72,    73,    74,    75,    76,     0,     0,
     123,     4,     5,     6,     7,     0,     0,     8,     0,    10,
      11,    12,    13,    14,    15,    16,    17,     0,    18,    19,
      20,     0,    21,    22,    23,    24,    25,    26,    27,    28,
       0,    29,     0,     0,    30,     4,    93,     6,     7,     0,
      31,     8,    32,     0,     0,    12,     0,     0,     0,     0,
      17,     0,    18,    19,    20,     0,    21,    22,     0,     0,
      25,     4,     0,     6,     7,    29,     0,     8,    30,     0,
       0,    12,     0,     0,    31,     0,    17,     0,    18,    19,
      20,     0,    21,    22,     0,     0,    25,     4,     0,    79,
       7,    29,     0,     8,    30,     0,     0,    12,     0,     0,
      31,     0,    17,     0,    18,    19,    20,     0,    21,    22,
       0,     0,    25,     4,     0,   131,     7,    29,     0,     8,
      30,     0,     0,    12,     0,     0,    31,     0,    17,     0,
      18,    19,    20,     0,    21,    22,     0,     0,    25,     0,
      68,    69,     0,    29,     0,     0,    30,    70,     0,     0,
       0,     0,    31,     0,     0,     0,     0,     0,     0,     0,
       0,     0,     0,     0,     0,     0,     0,     0,     0,     0,
       0,     0,     0,     0,    71,    72,    73,    74,    75,    76
};

static const yytype_int16 yycheck[] =
{
       3,     1,     4,   146,     3,     3,    37,   148,   151,    45,
       3,    13,     3,    45,    50,     3,    38,    39,    40,    41,
      42,    43,    45,    50,    10,    45,    12,    50,    30,    31,
      50,     8,     8,    26,    45,    45,   179,   178,    45,    45,
      45,    43,    44,     4,     5,    44,    44,    43,    50,    48,
      11,   194,    54,    44,    56,    57,    44,    48,    60,    46,
      63,    49,     8,    40,    40,    45,    45,    67,    70,    71,
      72,    73,    74,    75,    76,    52,    52,    38,    39,    40,
      41,    42,    43,    46,    86,    49,    88,    46,    45,    49,
      51,    40,    41,    42,    43,    50,    99,    44,    98,     8,
     102,   103,     8,    46,    49,     3,    46,    51,    50,   111,
     112,     6,   114,     8,     9,    50,    47,    12,    51,    51,
      50,    16,   124,     8,     8,    44,    21,     4,    23,    24,
      25,    22,    27,    28,    11,     3,    31,    51,    50,    50,
     142,    36,    11,    51,    39,    46,   148,   150,    51,   188,
      45,   124,   181,     8,    -1,    -1,    51,    -1,    -1,   162,
      -1,    38,    39,    40,    41,    42,    43,    -1,    -1,    38,
      39,    40,    41,    42,    43,    -1,   178,    -1,    -1,    -1,
      -1,    -1,    -1,   186,    -1,    -1,    -1,    -1,     0,     1,
      -1,     3,    -1,   196,     6,     7,     8,     9,    -1,    -1,
      12,    13,    14,    15,    16,    17,    18,    19,    20,    21,
      -1,    23,    24,    25,    -1,    27,    28,    29,    30,    31,
      32,    33,    34,     1,    36,     3,    -1,    39,     6,     7,
       8,     9,    44,    45,    12,    47,    14,    15,    16,    17,
      18,    19,    20,    21,    -1,    23,    24,    25,    -1,    27,
      28,    29,    30,    31,    32,    33,    34,    -1,    36,    -1,
      -1,    39,    -1,    -1,    -1,    -1,    44,    45,    -1,    47,
      48,     1,    -1,     3,    -1,    -1,     6,     7,     8,     9,
      -1,    -1,    12,    -1,    14,    15,    16,    17,    18,    19,
      20,    21,    -1,    23,    24,    25,    -1,    27,    28,    29,
      30,    31,    32,    33,    34,    -1,    36,    -1,    -1,    39,
      -1,    -1,    -1,    -1,    44,    45,    -1,    47,    48,     1,
      -1,     3,    -1,    -1,     6,     7,     8,     9,    -1,    -1,
      12,    -1,    14,    15,    16,    17,    18,    19,    20,    21,
      -1,    23,    24,    25,    -1,    27,    28,    29,    30,    31,
      32,    33,    34,    -1,    36,    -1,    -1,    39,     6,    -1,
       8,     9,    44,    45,    12,    47,    -1,    -1,    16,    -1,
      -1,    -1,    -1,    21,    -1,    23,    24,    25,    -1,    27,
      28,    -1,    -1,    31,    -1,    -1,    -1,    -1,    36,    -1,
      -1,    39,    -1,    -1,    -1,     3,    -1,    45,     6,     7,
       8,     9,    -1,    51,    12,    -1,    14,    15,    16,    17,
      18,    19,    20,    21,    -1,    23,    24,    25,    -1,    27,
      28,    29,    30,    31,    32,    33,    34,    -1,    36,     4,
       5,    39,    -1,    -1,    -1,    -1,    11,    45,    -1,    47,
       4,     5,    -1,    -1,    -1,    -1,    -1,    11,    -1,     4,
       5,    -1,    -1,    -1,    -1,    -1,    11,    -1,    -1,    -1,
      -1,    -1,    -1,    38,    39,    40,    41,    42,    43,    -1,
      -1,    46,    -1,    -1,    38,    39,    40,    41,    42,    43,
      -1,    -1,    46,    38,    39,    40,    41,    42,    43,     4,
       5,    46,     8,    -1,    -1,    -1,    11,    -1,     4,     5,
      -1,    -1,    -1,    -1,    -1,    11,    -1,    23,    24,    25,
      -1,    -1,    -1,    -1,    -1,    31,    -1,    -1,    -1,    -1,
      36,    -1,    -1,    38,    39,    40,    41,    42,    43,    -1,
      -1,    46,    38,    39,    40,    41,    42,    43,    -1,    -1,
      46,     6,     7,     8,     9,    -1,    -1,    12,    -1,    14,
      15,    16,    17,    18,    19,    20,    21,    -1,    23,    24,
      25,    -1,    27,    28,    29,    30,    31,    32,    33,    34,
      -1,    36,    -1,    -1,    39,     6,     7,     8,     9,    -1,
      45,    12,    47,    -1,    -1,    16,    -1,    -1,    -1,    -1,
      21,    -1,    23,    24,    25,    -1,    27,    28,    -1,    -1,
      31,     6,    -1,     8,     9,    36,    -1,    12,    39,    -1,
      -1,    16,    -1,    -1,    45,    -1,    21,    -1,    23,    24,
      25,    -1,    27,    28,    -1,    -1,    31,     6,    -1,     8,
       9,    36,    -1,    12,    39,    -1,    -1,    16,    -1,    -1,
      45,    -1,    21,    -1,    23,    24,    25,    -1,    27,    28,
      -1,    -1,    31,     6,    -1,     8,     9,    36,    -1,    12,
      39,    -1,    -1,    16,    -1,    -1,    45,    -1,    21,    -1,
      23,    24,    25,    -1,    27,    28,    -1,    -1,    31,    -1,
       4,     5,    -1,    36,    -1,    -1,    39,    11,    -1,    -1,
      -1,    -1,    45,    -1,    -1,    -1,    -1,    -1,    -1,    -1,
      -1,    -1,    -1,    -1,    -1,    -1,    -1,    -1,    -1,    -1,
      -1,    -1,    -1,    -1,    38,    39,    40,    41,    42,    43
};

  /* YYSTOS[STATE-NUM] -- The (internal number of the) accessing
     symbol of state STATE-NUM.  */
static const yytype_uint8 yystos[] =
{
       0,    54,     0,     1,     6,     7,     8,     9,    12,    13,
      14,    15,    16,    17,    18,    19,    20,    21,    23,    24,
      25,    27,    28,    29,    30,    31,    32,    33,    34,    36,
      39,    45,    47,    55,    57,    59,    60,    73,    83,    87,
       3,    60,    83,    45,    50,     8,    23,    87,    37,    75,
      45,    82,    83,    61,    45,    66,    45,    45,    45,    45,
      68,    83,    83,     1,    58,    59,     3,    44,     4,     5,
      11,    38,    39,    40,    41,    42,    43,    10,    12,     8,
      79,    80,    83,    83,     8,    83,    45,    83,    45,    83,
      83,    46,    46,     7,    69,    70,    83,    46,     3,    44,
      48,    59,    85,    86,    83,    83,    83,    83,    83,    83,
      83,    84,    50,    46,    49,    51,    45,    46,    81,    83,
      46,    83,    46,    46,    49,    59,    60,    83,    83,    83,
      51,     8,    83,     8,    40,    52,    76,    78,    44,    65,
      67,    69,    50,    50,     8,     8,    46,    49,    62,     3,
      56,    46,    51,    51,    50,    50,    56,     8,    40,    52,
      81,    60,    56,    51,    51,    47,    50,     8,     8,    44,
      22,    71,    60,     3,    88,    51,    50,    50,    63,    72,
       3,    26,    77,    51,    51,    81,    56,    78,    74,    46,
      60,     3,    44,    58,    64,    48,    56,    60
};

  /* YYR1[YYN] -- Symbol number of symbol that rule YYN derives.  */
static const yytype_uint8 yyr1[] =
{
       0,    53,    54,    54,    55,    55,    55,    56,    56,    57,
      57,    57,    57,    58,    58,    58,    58,    58,    58,    59,
      59,    60,    60,    60,    60,    60,    60,    60,    60,    60,
      61,    62,    63,    64,    60,    65,    60,    66,    67,    60,
      60,    68,    60,    69,    69,    70,    70,    71,    72,    71,
      74,    73,    75,    75,    76,    76,    77,    77,    77,    78,
      78,    78,    78,    78,    78,    78,    78,    79,    79,    80,
      80,    80,    80,    81,    81,    82,    82,    84,    83,    85,
      83,    86,    83,    83,    83,    83,    83,    83,    83,    83,
      83,    83,    83,    83,    83,    83,    83,    83,    83,    83,
      83,    83,    83,    87,    87,    87,    87,    87,    87,    87,
      88,    88,    88
};

  /* YYR2[YYN] -- Number of symbols on the right hand side of rule YYN.  */
static const yytype_uint8 yyr2[] =
{
       0,     2,     0,     2,     2,     1,     2,     0,     1,     0,
       1,     3,     2,     0,     1,     2,     3,     2,     3,     1,
       2,     1,     1,     1,     1,     1,     1,     1,     1,     2,
       0,     0,     0,     0,    14,     0,     8,     0,     0,     8,
       3,     0,     3,     1,     3,     1,     1,     0,     0,     4,
       0,    13,     0,     1,     0,     1,     0,     3,     3,     1,
       3,     4,     4,     3,     5,     6,     6,     0,     1,     1,
       3,     3,     5,     0,     1,     0,     1,     0,     4,     0,
       4,     0,     4,     2,     3,     3,     3,     3,     3,     3,
       3,     2,     1,     1,     3,     4,     2,     2,     4,     4,
       4,     3,     3,     1,     4,     1,     1,     1,     1,     1,
       0,     1,     2
};


#define yyerrok         (yyerrstatus = 0)
#define yyclearin       (yychar = YYEMPTY)
#define YYEMPTY         (-2)
#define YYEOF           0

#define YYACCEPT        goto yyacceptlab
#define YYABORT         goto yyabortlab
#define YYERROR         goto yyerrorlab


#define YYRECOVERING()  (!!yyerrstatus)

#define YYBACKUP(Token, Value)                                  \
do                                                              \
  if (yychar == YYEMPTY)                                        \
    {                                                           \
      yychar = (Token);                                         \
      yylval = (Value);                                         \
      YYPOPSTACK (yylen);                                       \
      yystate = *yyssp;                                         \
      goto yybackup;                                            \
    }                                                           \
  else                                                          \
    {                                                           \
      yyerror (YY_("syntax error: cannot back up")); \
      YYERROR;                                                  \
    }                                                           \
while (0)

/* Error token number */
#define YYTERROR        1
#define YYERRCODE       256



/* Enable debugging if requested.  */
#if YYDEBUG

# ifndef YYFPRINTF
#  include <stdio.h> /* INFRINGES ON USER NAME SPACE */
#  define YYFPRINTF fprintf
# endif

# define YYDPRINTF(Args)                        \
do {                                            \
  if (yydebug)                                  \
    YYFPRINTF Args;                             \
} while (0)

/* This macro is provided for backward compatibility. */
#ifndef YY_LOCATION_PRINT
# define YY_LOCATION_PRINT(File, Loc) ((void) 0)
#endif


# define YY_SYMBOL_PRINT(Title, Type, Value, Location)                    \
do {                                                                      \
  if (yydebug)                                                            \
    {                                                                     \
      YYFPRINTF (stderr, "%s ", Title);                                   \
      yy_symbol_print (stderr,                                            \
                  Type, Value); \
      YYFPRINTF (stderr, "\n");                                           \
    }                                                                     \
} while (0)


/*----------------------------------------.
| Print this symbol's value on YYOUTPUT.  |
`----------------------------------------*/

static void
yy_symbol_value_print (FILE *yyoutput, int yytype, YYSTYPE const * const yyvaluep)
{
  FILE *yyo = yyoutput;
  YYUSE (yyo);
  if (!yyvaluep)
    return;
# ifdef YYPRINT
  if (yytype < YYNTOKENS)
    YYPRINT (yyoutput, yytoknum[yytype], *yyvaluep);
# endif
  YYUSE (yytype);
}


/*--------------------------------.
| Print this symbol on YYOUTPUT.  |
`--------------------------------*/

static void
yy_symbol_print (FILE *yyoutput, int yytype, YYSTYPE const * const yyvaluep)
{
  YYFPRINTF (yyoutput, "%s %s (",
             yytype < YYNTOKENS ? "token" : "nterm", yytname[yytype]);

  yy_symbol_value_print (yyoutput, yytype, yyvaluep);
  YYFPRINTF (yyoutput, ")");
}

/*------------------------------------------------------------------.
| yy_stack_print -- Print the state stack from its BOTTOM up to its |
| TOP (included).                                                   |
`------------------------------------------------------------------*/

static void
yy_stack_print (yytype_int16 *yybottom, yytype_int16 *yytop)
{
  YYFPRINTF (stderr, "Stack now");
  for (; yybottom <= yytop; yybottom++)
    {
      int yybot = *yybottom;
      YYFPRINTF (stderr, " %d", yybot);
    }
  YYFPRINTF (stderr, "\n");
}

# define YY_STACK_PRINT(Bottom, Top)                            \
do {                                                            \
  if (yydebug)                                                  \
    yy_stack_print ((Bottom), (Top));                           \
} while (0)


/*------------------------------------------------.
| Report that the YYRULE is going to be reduced.  |
`------------------------------------------------*/

static void
yy_reduce_print (yytype_int16 *yyssp, YYSTYPE *yyvsp, int yyrule)
{
  unsigned long int yylno = yyrline[yyrule];
  int yynrhs = yyr2[yyrule];
  int yyi;
  YYFPRINTF (stderr, "Reducing stack by rule %d (line %lu):\n",
             yyrule - 1, yylno);
  /* The symbols being reduced.  */
  for (yyi = 0; yyi < yynrhs; yyi++)
    {
      YYFPRINTF (stderr, "   $%d = ", yyi + 1);
      yy_symbol_print (stderr,
                       yystos[yyssp[yyi + 1 - yynrhs]],
                       &(yyvsp[(yyi + 1) - (yynrhs)])
                                              );
      YYFPRINTF (stderr, "\n");
    }
}

# define YY_REDUCE_PRINT(Rule)          \
do {                                    \
  if (yydebug)                          \
    yy_reduce_print (yyssp, yyvsp, Rule); \
} while (0)

/* Nonzero means print parse trace.  It is left uninitialized so that
   multiple parsers can coexist.  */
int yydebug;
#else /* !YYDEBUG */
# define YYDPRINTF(Args)
# define YY_SYMBOL_PRINT(Title, Type, Value, Location)
# define YY_STACK_PRINT(Bottom, Top)
# define YY_REDUCE_PRINT(Rule)
#endif /* !YYDEBUG */


/* YYINITDEPTH -- initial size of the parser's stacks.  */
#ifndef YYINITDEPTH
# define YYINITDEPTH 200
#endif

/* YYMAXDEPTH -- maximum size the stacks can grow to (effective only
   if the built-in stack extension method is used).

   Do not make this value too large; the results are undefined if
   YYSTACK_ALLOC_MAXIMUM < YYSTACK_BYTES (YYMAXDEPTH)
   evaluated with infinite-precision integer arithmetic.  */

#ifndef YYMAXDEPTH
# define YYMAXDEPTH 10000
#endif


#if YYERROR_VERBOSE

# ifndef yystrlen
#  if defined __GLIBC__ && defined _STRING_H
#   define yystrlen strlen
#  else
/* Return the length of YYSTR.  */
static YYSIZE_T
yystrlen (const char *yystr)
{
  YYSIZE_T yylen;
  for (yylen = 0; yystr[yylen]; yylen++)
    continue;
  return yylen;
}
#  endif
# endif

# ifndef yystpcpy
#  if defined __GLIBC__ && defined _STRING_H && defined _GNU_SOURCE
#   define yystpcpy stpcpy
#  else
/* Copy YYSRC to YYDEST, returning the address of the terminating '\0' in
   YYDEST.  */
static char *
yystpcpy (char *yydest, const char *yysrc)
{
  char *yyd = yydest;
  const char *yys = yysrc;

  while ((*yyd++ = *yys++) != '\0')
    continue;

  return yyd - 1;
}
#  endif
# endif

# ifndef yytnamerr
/* Copy to YYRES the contents of YYSTR after stripping away unnecessary
   quotes and backslashes, so that it's suitable for yyerror.  The
   heuristic is that double-quoting is unnecessary unless the string
   contains an apostrophe, a comma, or backslash (other than
   backslash-backslash).  YYSTR is taken from yytname.  If YYRES is
   null, do not copy; instead, return the length of what the result
   would have been.  */
static YYSIZE_T
yytnamerr (char *yyres, const char *yystr)
{
  if (*yystr == '"')
    {
      YYSIZE_T yyn = 0;
      char const *yyp = yystr;

      for (;;)
        switch (*++yyp)
          {
          case '\'':
          case ',':
            goto do_not_strip_quotes;

          case '\\':
            if (*++yyp != '\\')
              goto do_not_strip_quotes;
            /* Fall through.  */
          default:
            if (yyres)
              yyres[yyn] = *yyp;
            yyn++;
            break;

          case '"':
            if (yyres)
              yyres[yyn] = '\0';
            return yyn;
          }
    do_not_strip_quotes: ;
    }

  if (! yyres)
    return yystrlen (yystr);

  return yystpcpy (yyres, yystr) - yyres;
}
# endif

/* Copy into *YYMSG, which is of size *YYMSG_ALLOC, an error message
   about the unexpected token YYTOKEN for the state stack whose top is
   YYSSP.

   Return 0 if *YYMSG was successfully written.  Return 1 if *YYMSG is
   not large enough to hold the message.  In that case, also set
   *YYMSG_ALLOC to the required number of bytes.  Return 2 if the
   required number of bytes is too large to store.  */
static int
yysyntax_error (YYSIZE_T *yymsg_alloc, char **yymsg,
                yytype_int16 *yyssp, int yytoken)
{
  YYSIZE_T yysize0 = yytnamerr (YY_NULLPTR, yytname[yytoken]);
  YYSIZE_T yysize = yysize0;
  enum { YYERROR_VERBOSE_ARGS_MAXIMUM = 5 };
  /* Internationalized format string. */
  const char *yyformat = YY_NULLPTR;
  /* Arguments of yyformat. */
  char const *yyarg[YYERROR_VERBOSE_ARGS_MAXIMUM];
  /* Number of reported tokens (one for the "unexpected", one per
     "expected"). */
  int yycount = 0;

  /* There are many possibilities here to consider:
     - If this state is a consistent state with a default action, then
       the only way this function was invoked is if the default action
       is an error action.  In that case, don't check for expected
       tokens because there are none.
     - The only way there can be no lookahead present (in yychar) is if
       this state is a consistent state with a default action.  Thus,
       detecting the absence of a lookahead is sufficient to determine
       that there is no unexpected or expected token to report.  In that
       case, just report a simple "syntax error".
     - Don't assume there isn't a lookahead just because this state is a
       consistent state with a default action.  There might have been a
       previous inconsistent state, consistent state with a non-default
       action, or user semantic action that manipulated yychar.
     - Of course, the expected token list depends on states to have
       correct lookahead information, and it depends on the parser not
       to perform extra reductions after fetching a lookahead from the
       scanner and before detecting a syntax error.  Thus, state merging
       (from LALR or IELR) and default reductions corrupt the expected
       token list.  However, the list is correct for canonical LR with
       one exception: it will still contain any token that will not be
       accepted due to an error action in a later state.
  */
  if (yytoken != YYEMPTY)
    {
      int yyn = yypact[*yyssp];
      yyarg[yycount++] = yytname[yytoken];
      if (!yypact_value_is_default (yyn))
        {
          /* Start YYX at -YYN if negative to avoid negative indexes in
             YYCHECK.  In other words, skip the first -YYN actions for
             this state because they are default actions.  */
          int yyxbegin = yyn < 0 ? -yyn : 0;
          /* Stay within bounds of both yycheck and yytname.  */
          int yychecklim = YYLAST - yyn + 1;
          int yyxend = yychecklim < YYNTOKENS ? yychecklim : YYNTOKENS;
          int yyx;

          for (yyx = yyxbegin; yyx < yyxend; ++yyx)
            if (yycheck[yyx + yyn] == yyx && yyx != YYTERROR
                && !yytable_value_is_error (yytable[yyx + yyn]))
              {
                if (yycount == YYERROR_VERBOSE_ARGS_MAXIMUM)
                  {
                    yycount = 1;
                    yysize = yysize0;
                    break;
                  }
                yyarg[yycount++] = yytname[yyx];
                {
                  YYSIZE_T yysize1 = yysize + yytnamerr (YY_NULLPTR, yytname[yyx]);
                  if (! (yysize <= yysize1
                         && yysize1 <= YYSTACK_ALLOC_MAXIMUM))
                    return 2;
                  yysize = yysize1;
                }
              }
        }
    }

  switch (yycount)
    {
# define YYCASE_(N, S)                      \
      case N:                               \
        yyformat = S;                       \
      break
      YYCASE_(0, YY_("syntax error"));
      YYCASE_(1, YY_("syntax error, unexpected %s"));
      YYCASE_(2, YY_("syntax error, unexpected %s, expecting %s"));
      YYCASE_(3, YY_("syntax error, unexpected %s, expecting %s or %s"));
      YYCASE_(4, YY_("syntax error, unexpected %s, expecting %s or %s or %s"));
      YYCASE_(5, YY_("syntax error, unexpected %s, expecting %s or %s or %s or %s"));
# undef YYCASE_
    }

  {
    YYSIZE_T yysize1 = yysize + yystrlen (yyformat);
    if (! (yysize <= yysize1 && yysize1 <= YYSTACK_ALLOC_MAXIMUM))
      return 2;
    yysize = yysize1;
  }

  if (*yymsg_alloc < yysize)
    {
      *yymsg_alloc = 2 * yysize;
      if (! (yysize <= *yymsg_alloc
             && *yymsg_alloc <= YYSTACK_ALLOC_MAXIMUM))
        *yymsg_alloc = YYSTACK_ALLOC_MAXIMUM;
      return 1;
    }

  /* Avoid sprintf, as that infringes on the user's name space.
     Don't have undefined behavior even if the translation
     produced a string with the wrong number of "%s"s.  */
  {
    char *yyp = *yymsg;
    int yyi = 0;
    while ((*yyp = *yyformat) != '\0')
      if (*yyp == '%' && yyformat[1] == 's' && yyi < yycount)
        {
          yyp += yytnamerr (yyp, yyarg[yyi++]);
          yyformat += 2;
        }
      else
        {
          yyp++;
          yyformat++;
        }
  }
  return 0;
}
#endif /* YYERROR_VERBOSE */

/*-----------------------------------------------.
| Release the memory associated to this symbol.  |
`-----------------------------------------------*/

static void
yydestruct (const char *yymsg, int yytype, YYSTYPE *yyvaluep)
{
  YYUSE (yyvaluep);
  if (!yymsg)
    yymsg = "Deleting";
  YY_SYMBOL_PRINT (yymsg, yytype, yyvaluep, yylocationp);

  YY_IGNORE_MAYBE_UNINITIALIZED_BEGIN
  YYUSE (yytype);
  YY_IGNORE_MAYBE_UNINITIALIZED_END
}




/* The lookahead symbol.  */
int yychar;

/* The semantic value of the lookahead symbol.  */
YYSTYPE yylval;
/* Number of syntax errors so far.  */
int yynerrs;


/*----------.
| yyparse.  |
`----------*/

int
yyparse (void)
{
    int yystate;
    /* Number of tokens to shift before error messages enabled.  */
    int yyerrstatus;

    /* The stacks and their tools:
       'yyss': related to states.
       'yyvs': related to semantic values.

       Refer to the stacks through separate pointers, to allow yyoverflow
       to reallocate them elsewhere.  */

    /* The state stack.  */
    yytype_int16 yyssa[YYINITDEPTH];
    yytype_int16 *yyss;
    yytype_int16 *yyssp;

    /* The semantic value stack.  */
    YYSTYPE yyvsa[YYINITDEPTH];
    YYSTYPE *yyvs;
    YYSTYPE *yyvsp;

    YYSIZE_T yystacksize;

  int yyn;
  int yyresult;
  /* Lookahead token as an internal (translated) token number.  */
  int yytoken = 0;
  /* The variables used to return semantic value and location from the
     action routines.  */
  YYSTYPE yyval;

#if YYERROR_VERBOSE
  /* Buffer for error messages, and its allocated size.  */
  char yymsgbuf[128];
  char *yymsg = yymsgbuf;
  YYSIZE_T yymsg_alloc = sizeof yymsgbuf;
#endif

#define YYPOPSTACK(N)   (yyvsp -= (N), yyssp -= (N))

  /* The number of symbols on the RHS of the reduced rule.
     Keep to zero when no symbol should be popped.  */
  int yylen = 0;

  yyssp = yyss = yyssa;
  yyvsp = yyvs = yyvsa;
  yystacksize = YYINITDEPTH;

  YYDPRINTF ((stderr, "Starting parse\n"));

  yystate = 0;
  yyerrstatus = 0;
  yynerrs = 0;
  yychar = YYEMPTY; /* Cause a token to be read.  */
  goto yysetstate;

/*------------------------------------------------------------.
| yynewstate -- Push a new state, which is found in yystate.  |
`------------------------------------------------------------*/
 yynewstate:
  /* In all cases, when you get here, the value and location stacks
     have just been pushed.  So pushing a state here evens the stacks.  */
  yyssp++;

 yysetstate:
  *yyssp = yystate;

  if (yyss + yystacksize - 1 <= yyssp)
    {
      /* Get the current used size of the three stacks, in elements.  */
      YYSIZE_T yysize = yyssp - yyss + 1;

#ifdef yyoverflow
      {
        /* Give user a chance to reallocate the stack.  Use copies of
           these so that the &'s don't force the real ones into
           memory.  */
        YYSTYPE *yyvs1 = yyvs;
        yytype_int16 *yyss1 = yyss;

        /* Each stack pointer address is followed by the size of the
           data in use in that stack, in bytes.  This used to be a
           conditional around just the two extra args, but that might
           be undefined if yyoverflow is a macro.  */
        yyoverflow (YY_("memory exhausted"),
                    &yyss1, yysize * sizeof (*yyssp),
                    &yyvs1, yysize * sizeof (*yyvsp),
                    &yystacksize);

        yyss = yyss1;
        yyvs = yyvs1;
      }
#else /* no yyoverflow */
# ifndef YYSTACK_RELOCATE
      goto yyexhaustedlab;
# else
      /* Extend the stack our own way.  */
      if (YYMAXDEPTH <= yystacksize)
        goto yyexhaustedlab;
      yystacksize *= 2;
      if (YYMAXDEPTH < yystacksize)
        yystacksize = YYMAXDEPTH;

      {
        yytype_int16 *yyss1 = yyss;
        union yyalloc *yyptr =
          (union yyalloc *) YYSTACK_ALLOC (YYSTACK_BYTES (yystacksize));
        if (! yyptr)
          goto yyexhaustedlab;
        YYSTACK_RELOCATE (yyss_alloc, yyss);
        YYSTACK_RELOCATE (yyvs_alloc, yyvs);
#  undef YYSTACK_RELOCATE
        if (yyss1 != yyssa)
          YYSTACK_FREE (yyss1);
      }
# endif
#endif /* no yyoverflow */

      yyssp = yyss + yysize - 1;
      yyvsp = yyvs + yysize - 1;

      YYDPRINTF ((stderr, "Stack size increased to %lu\n",
                  (unsigned long int) yystacksize));

      if (yyss + yystacksize - 1 <= yyssp)
        YYABORT;
    }

  YYDPRINTF ((stderr, "Entering state %d\n", yystate));

  if (yystate == YYFINAL)
    YYACCEPT;

  goto yybackup;

/*-----------.
| yybackup.  |
`-----------*/
yybackup:

  /* Do appropriate processing given the current state.  Read a
     lookahead token if we need one and don't already have one.  */

  /* First try to decide what to do without reference to lookahead token.  */
  yyn = yypact[yystate];
  if (yypact_value_is_default (yyn))
    goto yydefault;

  /* Not known => get a lookahead token if don't already have one.  */

  /* YYCHAR is either YYEMPTY or YYEOF or a valid lookahead symbol.  */
  if (yychar == YYEMPTY)
    {
      YYDPRINTF ((stderr, "Reading a token: "));
      yychar = yylex ();
    }

  if (yychar <= YYEOF)
    {
      yychar = yytoken = YYEOF;
      YYDPRINTF ((stderr, "Now at end of input.\n"));
    }
  else
    {
      yytoken = YYTRANSLATE (yychar);
      YY_SYMBOL_PRINT ("Next token is", yytoken, &yylval, &yylloc);
    }

  /* If the proper action on seeing token YYTOKEN is to reduce or to
     detect an error, take that action.  */
  yyn += yytoken;
  if (yyn < 0 || YYLAST < yyn || yycheck[yyn] != yytoken)
    goto yydefault;
  yyn = yytable[yyn];
  if (yyn <= 0)
    {
      if (yytable_value_is_error (yyn))
        goto yyerrlab;
      yyn = -yyn;
      goto yyreduce;
    }

  /* Count tokens shifted since error; after three, turn off error
     status.  */
  if (yyerrstatus)
    yyerrstatus--;

  /* Shift the lookahead token.  */
  YY_SYMBOL_PRINT ("Shifting", yytoken, &yylval, &yylloc);

  /* Discard the shifted token.  */
  yychar = YYEMPTY;

  yystate = yyn;
  YY_IGNORE_MAYBE_UNINITIALIZED_BEGIN
  *++yyvsp = yylval;
  YY_IGNORE_MAYBE_UNINITIALIZED_END

  goto yynewstate;


/*-----------------------------------------------------------.
| yydefault -- do the default action for the current state.  |
`-----------------------------------------------------------*/
yydefault:
  yyn = yydefact[yystate];
  if (yyn == 0)
    goto yyerrlab;
  goto yyreduce;


/*-----------------------------.
| yyreduce -- Do a reduction.  |
`-----------------------------*/
yyreduce:
  /* yyn is the number of a rule to reduce with.  */
  yylen = yyr2[yyn];

  /* If YYLEN is nonzero, implement the default value of the action:
     '$$ = $1'.

     Otherwise, the following line sets YYVAL to garbage.
     This behavior is undocumented and Bison
     users should not rely upon it.  Assigning to YYVAL
     unconditionally makes the parser a bit smaller, and it avoids a
     GCC warning that YYVAL may be used uninitialized.  */
  yyval = yyvsp[1-yylen];


  YY_REDUCE_PRINT (yyn);
  switch (yyn)
    {
        case 2:
#line 123 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      (yyval.i_value) = 0;
			      if (interactive && !quiet)
				{
				  show_bc_version ();
				  welcome ();
				}
			    }
#line 1553 "bc.c" /* yacc.c:1646  */
    break;

  case 4:
#line 134 "../../bc/bc.y" /* yacc.c:1646  */
    { run_code (); }
#line 1559 "bc.c" /* yacc.c:1646  */
    break;

  case 5:
#line 136 "../../bc/bc.y" /* yacc.c:1646  */
    { run_code (); }
#line 1565 "bc.c" /* yacc.c:1646  */
    break;

  case 6:
#line 138 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      yyerrok;
			      init_gen ();
			    }
#line 1574 "bc.c" /* yacc.c:1646  */
    break;

  case 8:
#line 145 "../../bc/bc.y" /* yacc.c:1646  */
    { ct_warn ("newline not allowed"); }
#line 1580 "bc.c" /* yacc.c:1646  */
    break;

  case 9:
#line 148 "../../bc/bc.y" /* yacc.c:1646  */
    { (yyval.i_value) = 0; }
#line 1586 "bc.c" /* yacc.c:1646  */
    break;

  case 13:
#line 154 "../../bc/bc.y" /* yacc.c:1646  */
    { (yyval.i_value) = 0; }
#line 1592 "bc.c" /* yacc.c:1646  */
    break;

  case 20:
#line 163 "../../bc/bc.y" /* yacc.c:1646  */
    { (yyval.i_value) = (yyvsp[0].i_value); }
#line 1598 "bc.c" /* yacc.c:1646  */
    break;

  case 21:
#line 166 "../../bc/bc.y" /* yacc.c:1646  */
    { warranty (""); }
#line 1604 "bc.c" /* yacc.c:1646  */
    break;

  case 22:
#line 168 "../../bc/bc.y" /* yacc.c:1646  */
    { limits (); }
#line 1610 "bc.c" /* yacc.c:1646  */
    break;

  case 23:
#line 170 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      if ((yyvsp[0].i_value) & EX_COMP)
				ct_warn ("comparison in expression");
			      if ((yyvsp[0].i_value) & EX_REG)
				generate ("W");
			      else 
				generate ("p");
			    }
#line 1623 "bc.c" /* yacc.c:1646  */
    break;

  case 24:
#line 179 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      (yyval.i_value) = 0;
			      generate ("w");
			      generate ((yyvsp[0].s_value));
			      free ((yyvsp[0].s_value));
			    }
#line 1634 "bc.c" /* yacc.c:1646  */
    break;

  case 25:
#line 186 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      if (break_label == 0)
				yyerror ("Break outside a for/while");
			      else
				{
				  snprintf (genstr, genlen, "J%1d:",
				  	    break_label);
				  generate (genstr);
				}
			    }
#line 1649 "bc.c" /* yacc.c:1646  */
    break;

  case 26:
#line 197 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      ct_warn ("Continue statement");
			      if (continue_label == 0)
				yyerror ("Continue outside a for");
			      else
				{
				  snprintf (genstr, genlen, "J%1d:", 
					    continue_label);
				  generate (genstr);
				}
			    }
#line 1665 "bc.c" /* yacc.c:1646  */
    break;

  case 27:
#line 209 "../../bc/bc.y" /* yacc.c:1646  */
    { bc_exit (0); }
#line 1671 "bc.c" /* yacc.c:1646  */
    break;

  case 28:
#line 211 "../../bc/bc.y" /* yacc.c:1646  */
    { generate ("h"); }
#line 1677 "bc.c" /* yacc.c:1646  */
    break;

  case 29:
#line 213 "../../bc/bc.y" /* yacc.c:1646  */
    { generate ("R"); }
#line 1683 "bc.c" /* yacc.c:1646  */
    break;

  case 30:
#line 215 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      (yyvsp[0].i_value) = break_label; 
			      break_label = next_label++;
			    }
#line 1692 "bc.c" /* yacc.c:1646  */
    break;

  case 31:
#line 220 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      if ((yyvsp[-1].i_value) & EX_COMP)
				ct_warn ("Comparison in first for expression");
			      if ((yyvsp[-1].i_value) & EX_VOID)
				yyerror ("first expression is void");
			      if (!((yyvsp[-1].i_value) & EX_EMPTY))
				generate ("p");
			      (yyvsp[-1].i_value) = next_label++;
			      snprintf (genstr, genlen, "N%1d:", (yyvsp[-1].i_value));
			      generate (genstr);
			    }
#line 1708 "bc.c" /* yacc.c:1646  */
    break;

  case 32:
#line 232 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      if ((yyvsp[-1].i_value) & EX_VOID)
				yyerror ("second expression is void");
			      if ((yyvsp[-1].i_value) & EX_EMPTY ) generate ("1");
			      (yyvsp[-1].i_value) = next_label++;
			      snprintf (genstr, genlen, "B%1d:J%1d:", (yyvsp[-1].i_value),
			      		break_label);
			      generate (genstr);
			      (yyval.i_value) = continue_label;
			      continue_label = next_label++;
			      snprintf (genstr, genlen, "N%1d:", 
			      		continue_label);
			      generate (genstr);
			    }
#line 1727 "bc.c" /* yacc.c:1646  */
    break;

  case 33:
#line 247 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      if ((yyvsp[-1].i_value) & EX_COMP)
				ct_warn ("Comparison in third for expression");
			      if ((yyvsp[-1].i_value) & EX_VOID)
				yyerror ("third expression is void");
			      if ((yyvsp[-1].i_value) & EX_EMPTY)
				snprintf (genstr, genlen, "J%1d:N%1d:", (yyvsp[-7].i_value), (yyvsp[-4].i_value));
			      else
				snprintf (genstr, genlen, "pJ%1d:N%1d:", (yyvsp[-7].i_value), (yyvsp[-4].i_value));
			      generate (genstr);
			    }
#line 1743 "bc.c" /* yacc.c:1646  */
    break;

  case 34:
#line 259 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      snprintf (genstr, genlen, "J%1d:N%1d:",
				       continue_label, break_label);
			      generate (genstr);
			      break_label = (yyvsp[-13].i_value);
			      continue_label = (yyvsp[-5].i_value);
			    }
#line 1755 "bc.c" /* yacc.c:1646  */
    break;

  case 35:
#line 267 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      if ((yyvsp[-1].i_value) & EX_VOID)
				yyerror ("void expression");
			      (yyvsp[-1].i_value) = if_label;
			      if_label = next_label++;
			      snprintf (genstr, genlen, "Z%1d:", if_label);
			      generate (genstr);
			    }
#line 1768 "bc.c" /* yacc.c:1646  */
    break;

  case 36:
#line 276 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      snprintf (genstr, genlen, "N%1d:", if_label); 
			      generate (genstr);
			      if_label = (yyvsp[-5].i_value);
			    }
#line 1778 "bc.c" /* yacc.c:1646  */
    break;

  case 37:
#line 282 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      (yyvsp[0].i_value) = continue_label;
			      continue_label = next_label++;
			      snprintf (genstr, genlen, "N%1d:", 
					continue_label);
			      generate (genstr);
			    }
#line 1790 "bc.c" /* yacc.c:1646  */
    break;

  case 38:
#line 290 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      if ((yyvsp[0].i_value) & EX_VOID)
				yyerror ("void expression");
			      (yyvsp[0].i_value) = break_label; 
			      break_label = next_label++;
			      snprintf (genstr, genlen, "Z%1d:", break_label);
			      generate (genstr);
			    }
#line 1803 "bc.c" /* yacc.c:1646  */
    break;

  case 39:
#line 299 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      snprintf (genstr, genlen, "J%1d:N%1d:", 
					continue_label, break_label);
			      generate (genstr);
			      break_label = (yyvsp[-4].i_value);
			      continue_label = (yyvsp[-7].i_value);
			    }
#line 1815 "bc.c" /* yacc.c:1646  */
    break;

  case 40:
#line 307 "../../bc/bc.y" /* yacc.c:1646  */
    { (yyval.i_value) = 0; }
#line 1821 "bc.c" /* yacc.c:1646  */
    break;

  case 41:
#line 309 "../../bc/bc.y" /* yacc.c:1646  */
    {  ct_warn ("print statement"); }
#line 1827 "bc.c" /* yacc.c:1646  */
    break;

  case 45:
#line 316 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      generate ("O");
			      generate ((yyvsp[0].s_value));
			      free ((yyvsp[0].s_value));
			    }
#line 1837 "bc.c" /* yacc.c:1646  */
    break;

  case 46:
#line 322 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      if ((yyvsp[0].i_value) & EX_VOID)
				yyerror ("void expression in print");
			      generate ("P");
			    }
#line 1847 "bc.c" /* yacc.c:1646  */
    break;

  case 48:
#line 330 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      ct_warn ("else clause in if statement");
			      (yyvsp[0].i_value) = next_label++;
			      snprintf (genstr, genlen, "J%d:N%1d:", (yyvsp[0].i_value),
					if_label); 
			      generate (genstr);
			      if_label = (yyvsp[0].i_value);
			    }
#line 1860 "bc.c" /* yacc.c:1646  */
    break;

  case 50:
#line 342 "../../bc/bc.y" /* yacc.c:1646  */
    { char *params, *autos;
			      /* Check auto list against parameter list? */
			      check_params ((yyvsp[-5].a_value),(yyvsp[0].a_value));
			      params = arg_str ((yyvsp[-5].a_value));
			      autos  = arg_str ((yyvsp[0].a_value));
			      set_genstr_size (30 + strlen (params)
					       + strlen (autos));
			      cur_func = lookup((yyvsp[-7].s_value),FUNCTDEF);
			      snprintf (genstr, genlen, "F%d,%s.%s[", cur_func,
					params, autos); 
			      generate (genstr);
			      functions[cur_func].f_void = (yyvsp[-8].i_value);
			      free_args ((yyvsp[-5].a_value));
			      free_args ((yyvsp[0].a_value));
			      (yyvsp[-9].i_value) = next_label;
			      next_label = 1;
			    }
#line 1882 "bc.c" /* yacc.c:1646  */
    break;

  case 51:
#line 360 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      generate ("0R]");
			      next_label = (yyvsp[-12].i_value);
			      cur_func = -1;
			    }
#line 1892 "bc.c" /* yacc.c:1646  */
    break;

  case 52:
#line 367 "../../bc/bc.y" /* yacc.c:1646  */
    { (yyval.i_value) = 0; }
#line 1898 "bc.c" /* yacc.c:1646  */
    break;

  case 53:
#line 369 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      (yyval.i_value) = 1;
			      ct_warn ("void functions");
			    }
#line 1907 "bc.c" /* yacc.c:1646  */
    break;

  case 54:
#line 375 "../../bc/bc.y" /* yacc.c:1646  */
    { (yyval.a_value) = NULL; }
#line 1913 "bc.c" /* yacc.c:1646  */
    break;

  case 56:
#line 379 "../../bc/bc.y" /* yacc.c:1646  */
    { (yyval.a_value) = NULL; }
#line 1919 "bc.c" /* yacc.c:1646  */
    break;

  case 57:
#line 381 "../../bc/bc.y" /* yacc.c:1646  */
    { (yyval.a_value) = (yyvsp[-1].a_value); }
#line 1925 "bc.c" /* yacc.c:1646  */
    break;

  case 58:
#line 383 "../../bc/bc.y" /* yacc.c:1646  */
    { (yyval.a_value) = (yyvsp[-1].a_value); }
#line 1931 "bc.c" /* yacc.c:1646  */
    break;

  case 59:
#line 386 "../../bc/bc.y" /* yacc.c:1646  */
    { (yyval.a_value) = nextarg (NULL, lookup ((yyvsp[0].s_value),SIMPLE), FALSE);}
#line 1937 "bc.c" /* yacc.c:1646  */
    break;

  case 60:
#line 388 "../../bc/bc.y" /* yacc.c:1646  */
    { (yyval.a_value) = nextarg (NULL, lookup ((yyvsp[-2].s_value),ARRAY), FALSE); }
#line 1943 "bc.c" /* yacc.c:1646  */
    break;

  case 61:
#line 390 "../../bc/bc.y" /* yacc.c:1646  */
    { (yyval.a_value) = nextarg (NULL, lookup ((yyvsp[-2].s_value),ARRAY), TRUE);
			      ct_warn ("Call by variable arrays");
			    }
#line 1951 "bc.c" /* yacc.c:1646  */
    break;

  case 62:
#line 394 "../../bc/bc.y" /* yacc.c:1646  */
    { (yyval.a_value) = nextarg (NULL, lookup ((yyvsp[-2].s_value),ARRAY), TRUE);
			      ct_warn ("Call by variable arrays");
			    }
#line 1959 "bc.c" /* yacc.c:1646  */
    break;

  case 63:
#line 398 "../../bc/bc.y" /* yacc.c:1646  */
    { (yyval.a_value) = nextarg ((yyvsp[-2].a_value), lookup ((yyvsp[0].s_value),SIMPLE), FALSE); }
#line 1965 "bc.c" /* yacc.c:1646  */
    break;

  case 64:
#line 400 "../../bc/bc.y" /* yacc.c:1646  */
    { (yyval.a_value) = nextarg ((yyvsp[-4].a_value), lookup ((yyvsp[-2].s_value),ARRAY), FALSE); }
#line 1971 "bc.c" /* yacc.c:1646  */
    break;

  case 65:
#line 402 "../../bc/bc.y" /* yacc.c:1646  */
    { (yyval.a_value) = nextarg ((yyvsp[-5].a_value), lookup ((yyvsp[-2].s_value),ARRAY), TRUE);
			      ct_warn ("Call by variable arrays");
			    }
#line 1979 "bc.c" /* yacc.c:1646  */
    break;

  case 66:
#line 406 "../../bc/bc.y" /* yacc.c:1646  */
    { (yyval.a_value) = nextarg ((yyvsp[-5].a_value), lookup ((yyvsp[-2].s_value),ARRAY), TRUE);
			      ct_warn ("Call by variable arrays");
			    }
#line 1987 "bc.c" /* yacc.c:1646  */
    break;

  case 67:
#line 411 "../../bc/bc.y" /* yacc.c:1646  */
    { (yyval.a_value) = NULL; }
#line 1993 "bc.c" /* yacc.c:1646  */
    break;

  case 69:
#line 415 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      if ((yyvsp[0].i_value) & EX_COMP)
				ct_warn ("comparison in argument");
			      if ((yyvsp[0].i_value) & EX_VOID)
				yyerror ("void argument");
			      (yyval.a_value) = nextarg (NULL,0,FALSE);
			    }
#line 2005 "bc.c" /* yacc.c:1646  */
    break;

  case 70:
#line 423 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      snprintf (genstr, genlen, "K%d:",
					-lookup ((yyvsp[-2].s_value),ARRAY));
			      generate (genstr);
			      (yyval.a_value) = nextarg (NULL,1,FALSE);
			    }
#line 2016 "bc.c" /* yacc.c:1646  */
    break;

  case 71:
#line 430 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      if ((yyvsp[0].i_value) & EX_COMP)
				ct_warn ("comparison in argument");
			      if ((yyvsp[0].i_value) & EX_VOID)
				yyerror ("void argument");
			      (yyval.a_value) = nextarg ((yyvsp[-2].a_value),0,FALSE);
			    }
#line 2028 "bc.c" /* yacc.c:1646  */
    break;

  case 72:
#line 438 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      snprintf (genstr, genlen, "K%d:", 
					-lookup ((yyvsp[-2].s_value),ARRAY));
			      generate (genstr);
			      (yyval.a_value) = nextarg ((yyvsp[-4].a_value),1,FALSE);
			    }
#line 2039 "bc.c" /* yacc.c:1646  */
    break;

  case 73:
#line 456 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      (yyval.i_value) = EX_EMPTY;
			      ct_warn ("Missing expression in for statement");
			    }
#line 2048 "bc.c" /* yacc.c:1646  */
    break;

  case 75:
#line 463 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      (yyval.i_value) = 0;
			      generate ("0");
			      if (cur_func == -1)
				yyerror("Return outside of a function.");
			    }
#line 2059 "bc.c" /* yacc.c:1646  */
    break;

  case 76:
#line 470 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      if ((yyvsp[0].i_value) & EX_COMP)
				ct_warn ("comparison in return expresion");
			      if (!((yyvsp[0].i_value) & EX_PAREN))
				ct_warn ("return expression requires parenthesis");
			      if ((yyvsp[0].i_value) & EX_VOID)
				yyerror("return requires non-void expression");
			      if (cur_func == -1)
				yyerror("Return outside of a function.");
			      else if (functions[cur_func].f_void)
				yyerror("Return expression in a void function.");
			    }
#line 2076 "bc.c" /* yacc.c:1646  */
    break;

  case 77:
#line 484 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      if ((yyvsp[0].c_value) != '=')
				{
				  if ((yyvsp[-1].i_value) < 0)
				    snprintf (genstr, genlen, "DL%d:", -(yyvsp[-1].i_value));
				  else
				    snprintf (genstr, genlen, "l%d:", (yyvsp[-1].i_value));
				  generate (genstr);
				}
			    }
#line 2091 "bc.c" /* yacc.c:1646  */
    break;

  case 78:
#line 495 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      if ((yyvsp[0].i_value) & EX_ASSGN)
				ct_warn("comparison in assignment");
			      if ((yyvsp[0].i_value) & EX_VOID)
				yyerror("Assignment of a void expression");
			      if ((yyvsp[-2].c_value) != '=')
				{
				  snprintf (genstr, genlen, "%c", (yyvsp[-2].c_value));
				  generate (genstr);
				}
			      if ((yyvsp[-3].i_value) < 0)
				snprintf (genstr, genlen, "S%d:", -(yyvsp[-3].i_value));
			      else
				snprintf (genstr, genlen, "s%d:", (yyvsp[-3].i_value));
			      generate (genstr);
			      (yyval.i_value) = EX_ASSGN;
			    }
#line 2113 "bc.c" /* yacc.c:1646  */
    break;

  case 79:
#line 513 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      ct_warn("&& operator");
			      (yyvsp[0].i_value) = next_label++;
			      snprintf (genstr, genlen, "DZ%d:p", (yyvsp[0].i_value));
			      generate (genstr);
			    }
#line 2124 "bc.c" /* yacc.c:1646  */
    break;

  case 80:
#line 520 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      if (((yyvsp[-3].i_value) & EX_VOID) || ((yyvsp[0].i_value) & EX_VOID))
				yyerror ("void expression with &&");
			      snprintf (genstr, genlen, "DZ%d:p1N%d:", (yyvsp[-2].i_value), (yyvsp[-2].i_value));
			      generate (genstr);
			      (yyval.i_value) = ((yyvsp[-3].i_value) | (yyvsp[0].i_value)) & ~EX_PAREN;
			    }
#line 2136 "bc.c" /* yacc.c:1646  */
    break;

  case 81:
#line 528 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      ct_warn("|| operator");
			      (yyvsp[0].i_value) = next_label++;
			      snprintf (genstr, genlen, "B%d:", (yyvsp[0].i_value));
			      generate (genstr);
			    }
#line 2147 "bc.c" /* yacc.c:1646  */
    break;

  case 82:
#line 535 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      int tmplab;
			      if (((yyvsp[-3].i_value) & EX_VOID) || ((yyvsp[0].i_value) & EX_VOID))
				yyerror ("void expression with ||");
			      tmplab = next_label++;
			      snprintf (genstr, genlen, "B%d:0J%d:N%d:1N%d:",
				       (yyvsp[-2].i_value), tmplab, (yyvsp[-2].i_value), tmplab);
			      generate (genstr);
			      (yyval.i_value) = ((yyvsp[-3].i_value) | (yyvsp[0].i_value)) & ~EX_PAREN;
			    }
#line 2162 "bc.c" /* yacc.c:1646  */
    break;

  case 83:
#line 546 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      if ((yyvsp[0].i_value) & EX_VOID)
				yyerror ("void expression with !");
			      (yyval.i_value) = (yyvsp[0].i_value) & ~EX_PAREN;
			      ct_warn("! operator");
			      generate ("!");
			    }
#line 2174 "bc.c" /* yacc.c:1646  */
    break;

  case 84:
#line 554 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      if (((yyvsp[-2].i_value) & EX_VOID) || ((yyvsp[0].i_value) & EX_VOID))
				yyerror ("void expression with comparison");
			      (yyval.i_value) = EX_REG | EX_COMP;
			      switch (*((yyvsp[-1].s_value)))
				{
				case '=':
				  generate ("=");
				  break;

				case '!':
				  generate ("#");
				  break;

				case '<':
				  if ((yyvsp[-1].s_value)[1] == '=')
				    generate ("{");
				  else
				    generate ("<");
				  break;

				case '>':
				  if ((yyvsp[-1].s_value)[1] == '=')
				    generate ("}");
				  else
				    generate (">");
				  break;
				}
                              free((yyvsp[-1].s_value));
			    }
#line 2209 "bc.c" /* yacc.c:1646  */
    break;

  case 85:
#line 585 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      if (((yyvsp[-2].i_value) & EX_VOID) || ((yyvsp[0].i_value) & EX_VOID))
				yyerror ("void expression with +");
			      generate ("+");
			      (yyval.i_value) = ((yyvsp[-2].i_value) | (yyvsp[0].i_value)) & ~EX_PAREN;
			    }
#line 2220 "bc.c" /* yacc.c:1646  */
    break;

  case 86:
#line 592 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      if (((yyvsp[-2].i_value) & EX_VOID) || ((yyvsp[0].i_value) & EX_VOID))
				yyerror ("void expression with -");
			      generate ("-");
			      (yyval.i_value) = ((yyvsp[-2].i_value) | (yyvsp[0].i_value)) & ~EX_PAREN;
			    }
#line 2231 "bc.c" /* yacc.c:1646  */
    break;

  case 87:
#line 599 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      if (((yyvsp[-2].i_value) & EX_VOID) || ((yyvsp[0].i_value) & EX_VOID))
				yyerror ("void expression with *");
			      generate ("*");
			      (yyval.i_value) = ((yyvsp[-2].i_value) | (yyvsp[0].i_value)) & ~EX_PAREN;
			    }
#line 2242 "bc.c" /* yacc.c:1646  */
    break;

  case 88:
#line 606 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      if (((yyvsp[-2].i_value) & EX_VOID) || ((yyvsp[0].i_value) & EX_VOID))
				yyerror ("void expression with /");
			      generate ("/");
			      (yyval.i_value) = ((yyvsp[-2].i_value) | (yyvsp[0].i_value)) & ~EX_PAREN;
			    }
#line 2253 "bc.c" /* yacc.c:1646  */
    break;

  case 89:
#line 613 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      if (((yyvsp[-2].i_value) & EX_VOID) || ((yyvsp[0].i_value) & EX_VOID))
				yyerror ("void expression with %");
			      generate ("%");
			      (yyval.i_value) = ((yyvsp[-2].i_value) | (yyvsp[0].i_value)) & ~EX_PAREN;
			    }
#line 2264 "bc.c" /* yacc.c:1646  */
    break;

  case 90:
#line 620 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      if (((yyvsp[-2].i_value) & EX_VOID) || ((yyvsp[0].i_value) & EX_VOID))
				yyerror ("void expression with ^");
			      generate ("^");
			      (yyval.i_value) = ((yyvsp[-2].i_value) | (yyvsp[0].i_value)) & ~EX_PAREN;
			    }
#line 2275 "bc.c" /* yacc.c:1646  */
    break;

  case 91:
#line 627 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      if ((yyvsp[0].i_value) & EX_VOID)
				yyerror ("void expression with unary -");
			      generate ("n");
			      (yyval.i_value) = (yyvsp[0].i_value) & ~EX_PAREN;
			    }
#line 2286 "bc.c" /* yacc.c:1646  */
    break;

  case 92:
#line 634 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      (yyval.i_value) = EX_REG;
			      if ((yyvsp[0].i_value) < 0)
				snprintf (genstr, genlen, "L%d:", -(yyvsp[0].i_value));
			      else
				snprintf (genstr, genlen, "l%d:", (yyvsp[0].i_value));
			      generate (genstr);
			    }
#line 2299 "bc.c" /* yacc.c:1646  */
    break;

  case 93:
#line 643 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      int len = strlen((yyvsp[0].s_value));
			      (yyval.i_value) = EX_REG;
			      if (len == 1 && *(yyvsp[0].s_value) == '0')
				generate ("0");
			      else if (len == 1 && *(yyvsp[0].s_value) == '1')
				generate ("1");
			      else
				{
				  generate ("K");
				  generate ((yyvsp[0].s_value));
				  generate (":");
				}
			      free ((yyvsp[0].s_value));
			    }
#line 2319 "bc.c" /* yacc.c:1646  */
    break;

  case 94:
#line 659 "../../bc/bc.y" /* yacc.c:1646  */
    { 
			      if ((yyvsp[-1].i_value) & EX_VOID)
				yyerror ("void expression in parenthesis");
			      (yyval.i_value) = (yyvsp[-1].i_value) | EX_REG | EX_PAREN;
			    }
#line 2329 "bc.c" /* yacc.c:1646  */
    break;

  case 95:
#line 665 "../../bc/bc.y" /* yacc.c:1646  */
    { int fn;
			      fn = lookup ((yyvsp[-3].s_value),FUNCT);
			      if (functions[fn].f_void)
				(yyval.i_value) = EX_VOID;
			      else
				(yyval.i_value) = EX_REG;
			      if ((yyvsp[-1].a_value) != NULL)
				{ char *params = call_str ((yyvsp[-1].a_value));
				  set_genstr_size (20 + strlen (params));
				  snprintf (genstr, genlen, "C%d,%s:", fn,
				  	    params);
				  free_args ((yyvsp[-1].a_value));
				}
			      else
				{
				  snprintf (genstr, genlen, "C%d:", fn);
				}
			      generate (genstr);
			    }
#line 2353 "bc.c" /* yacc.c:1646  */
    break;

  case 96:
#line 685 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      (yyval.i_value) = EX_REG;
			      if ((yyvsp[0].i_value) < 0)
				{
				  if ((yyvsp[-1].c_value) == '+')
				    snprintf (genstr, genlen, "DA%d:L%d:", -(yyvsp[0].i_value), -(yyvsp[0].i_value));
				  else
				    snprintf (genstr, genlen, "DM%d:L%d:", -(yyvsp[0].i_value), -(yyvsp[0].i_value));
				}
			      else
				{
				  if ((yyvsp[-1].c_value) == '+')
				    snprintf (genstr, genlen, "i%d:l%d:", (yyvsp[0].i_value), (yyvsp[0].i_value));
				  else
				    snprintf (genstr, genlen, "d%d:l%d:", (yyvsp[0].i_value), (yyvsp[0].i_value));
				}
			      generate (genstr);
			    }
#line 2376 "bc.c" /* yacc.c:1646  */
    break;

  case 97:
#line 704 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      (yyval.i_value) = EX_REG;
			      if ((yyvsp[-1].i_value) < 0)
				{
				  snprintf (genstr, genlen, "DL%d:x", -(yyvsp[-1].i_value));
				  generate (genstr); 
				  if ((yyvsp[0].c_value) == '+')
				    snprintf (genstr, genlen, "A%d:", -(yyvsp[-1].i_value));
				  else
				      snprintf (genstr, genlen, "M%d:", -(yyvsp[-1].i_value));
				}
			      else
				{
				  snprintf (genstr, genlen, "l%d:", (yyvsp[-1].i_value));
				  generate (genstr);
				  if ((yyvsp[0].c_value) == '+')
				    snprintf (genstr, genlen, "i%d:", (yyvsp[-1].i_value));
				  else
				    snprintf (genstr, genlen, "d%d:", (yyvsp[-1].i_value));
				}
			      generate (genstr);
			    }
#line 2403 "bc.c" /* yacc.c:1646  */
    break;

  case 98:
#line 727 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      if ((yyvsp[-1].i_value) & EX_VOID)
				yyerror ("void expression in length()");
			      generate ("cL");
			      (yyval.i_value) = EX_REG;
			    }
#line 2414 "bc.c" /* yacc.c:1646  */
    break;

  case 99:
#line 734 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      if ((yyvsp[-1].i_value) & EX_VOID)
				yyerror ("void expression in sqrt()");
			      generate ("cR");
			      (yyval.i_value) = EX_REG;
			    }
#line 2425 "bc.c" /* yacc.c:1646  */
    break;

  case 100:
#line 741 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      if ((yyvsp[-1].i_value) & EX_VOID)
				yyerror ("void expression in scale()");
			      generate ("cS");
			      (yyval.i_value) = EX_REG;
			    }
#line 2436 "bc.c" /* yacc.c:1646  */
    break;

  case 101:
#line 748 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      ct_warn ("read function");
			      generate ("cI");
			      (yyval.i_value) = EX_REG;
			    }
#line 2446 "bc.c" /* yacc.c:1646  */
    break;

  case 102:
#line 754 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      ct_warn ("random function");
			      generate ("cX");
			      (yyval.i_value) = EX_REG;
			    }
#line 2456 "bc.c" /* yacc.c:1646  */
    break;

  case 103:
#line 761 "../../bc/bc.y" /* yacc.c:1646  */
    { (yyval.i_value) = lookup((yyvsp[0].s_value),SIMPLE); }
#line 2462 "bc.c" /* yacc.c:1646  */
    break;

  case 104:
#line 763 "../../bc/bc.y" /* yacc.c:1646  */
    {
			      if ((yyvsp[-1].i_value) & EX_VOID)
				yyerror("void expression as subscript");
			      if ((yyvsp[-1].i_value) & EX_COMP)
				ct_warn("comparison in subscript");
			      (yyval.i_value) = lookup((yyvsp[-3].s_value),ARRAY);
			    }
#line 2474 "bc.c" /* yacc.c:1646  */
    break;

  case 105:
#line 771 "../../bc/bc.y" /* yacc.c:1646  */
    { (yyval.i_value) = 0; }
#line 2480 "bc.c" /* yacc.c:1646  */
    break;

  case 106:
#line 773 "../../bc/bc.y" /* yacc.c:1646  */
    { (yyval.i_value) = 1; }
#line 2486 "bc.c" /* yacc.c:1646  */
    break;

  case 107:
#line 775 "../../bc/bc.y" /* yacc.c:1646  */
    { (yyval.i_value) = 2; }
#line 2492 "bc.c" /* yacc.c:1646  */
    break;

  case 108:
#line 777 "../../bc/bc.y" /* yacc.c:1646  */
    { (yyval.i_value) = 3;
			      ct_warn ("History variable");
			    }
#line 2500 "bc.c" /* yacc.c:1646  */
    break;

  case 109:
#line 781 "../../bc/bc.y" /* yacc.c:1646  */
    { (yyval.i_value) = 4;
			      ct_warn ("Last variable");
			    }
#line 2508 "bc.c" /* yacc.c:1646  */
    break;

  case 110:
#line 787 "../../bc/bc.y" /* yacc.c:1646  */
    { ct_warn ("End of line required"); }
#line 2514 "bc.c" /* yacc.c:1646  */
    break;

  case 112:
#line 790 "../../bc/bc.y" /* yacc.c:1646  */
    { ct_warn ("Too many end of lines"); }
#line 2520 "bc.c" /* yacc.c:1646  */
    break;


#line 2524 "bc.c" /* yacc.c:1646  */
      default: break;
    }
  /* User semantic actions sometimes alter yychar, and that requires
     that yytoken be updated with the new translation.  We take the
     approach of translating immediately before every use of yytoken.
     One alternative is translating here after every semantic action,
     but that translation would be missed if the semantic action invokes
     YYABORT, YYACCEPT, or YYERROR immediately after altering yychar or
     if it invokes YYBACKUP.  In the case of YYABORT or YYACCEPT, an
     incorrect destructor might then be invoked immediately.  In the
     case of YYERROR or YYBACKUP, subsequent parser actions might lead
     to an incorrect destructor call or verbose syntax error message
     before the lookahead is translated.  */
  YY_SYMBOL_PRINT ("-> $$ =", yyr1[yyn], &yyval, &yyloc);

  YYPOPSTACK (yylen);
  yylen = 0;
  YY_STACK_PRINT (yyss, yyssp);

  *++yyvsp = yyval;

  /* Now 'shift' the result of the reduction.  Determine what state
     that goes to, based on the state we popped back to and the rule
     number reduced by.  */

  yyn = yyr1[yyn];

  yystate = yypgoto[yyn - YYNTOKENS] + *yyssp;
  if (0 <= yystate && yystate <= YYLAST && yycheck[yystate] == *yyssp)
    yystate = yytable[yystate];
  else
    yystate = yydefgoto[yyn - YYNTOKENS];

  goto yynewstate;


/*--------------------------------------.
| yyerrlab -- here on detecting error.  |
`--------------------------------------*/
yyerrlab:
  /* Make sure we have latest lookahead translation.  See comments at
     user semantic actions for why this is necessary.  */
  yytoken = yychar == YYEMPTY ? YYEMPTY : YYTRANSLATE (yychar);

  /* If not already recovering from an error, report this error.  */
  if (!yyerrstatus)
    {
      ++yynerrs;
#if ! YYERROR_VERBOSE
      yyerror (YY_("syntax error"));
#else
# define YYSYNTAX_ERROR yysyntax_error (&yymsg_alloc, &yymsg, \
                                        yyssp, yytoken)
      {
        char const *yymsgp = YY_("syntax error");
        int yysyntax_error_status;
        yysyntax_error_status = YYSYNTAX_ERROR;
        if (yysyntax_error_status == 0)
          yymsgp = yymsg;
        else if (yysyntax_error_status == 1)
          {
            if (yymsg != yymsgbuf)
              YYSTACK_FREE (yymsg);
            yymsg = (char *) YYSTACK_ALLOC (yymsg_alloc);
            if (!yymsg)
              {
                yymsg = yymsgbuf;
                yymsg_alloc = sizeof yymsgbuf;
                yysyntax_error_status = 2;
              }
            else
              {
                yysyntax_error_status = YYSYNTAX_ERROR;
                yymsgp = yymsg;
              }
          }
        yyerror (yymsgp);
        if (yysyntax_error_status == 2)
          goto yyexhaustedlab;
      }
# undef YYSYNTAX_ERROR
#endif
    }



  if (yyerrstatus == 3)
    {
      /* If just tried and failed to reuse lookahead token after an
         error, discard it.  */

      if (yychar <= YYEOF)
        {
          /* Return failure if at end of input.  */
          if (yychar == YYEOF)
            YYABORT;
        }
      else
        {
          yydestruct ("Error: discarding",
                      yytoken, &yylval);
          yychar = YYEMPTY;
        }
    }

  /* Else will try to reuse lookahead token after shifting the error
     token.  */
  goto yyerrlab1;


/*---------------------------------------------------.
| yyerrorlab -- error raised explicitly by YYERROR.  |
`---------------------------------------------------*/
yyerrorlab:

  /* Pacify compilers like GCC when the user code never invokes
     YYERROR and the label yyerrorlab therefore never appears in user
     code.  */
  if (/*CONSTCOND*/ 0)
     goto yyerrorlab;

  /* Do not reclaim the symbols of the rule whose action triggered
     this YYERROR.  */
  YYPOPSTACK (yylen);
  yylen = 0;
  YY_STACK_PRINT (yyss, yyssp);
  yystate = *yyssp;
  goto yyerrlab1;


/*-------------------------------------------------------------.
| yyerrlab1 -- common code for both syntax error and YYERROR.  |
`-------------------------------------------------------------*/
yyerrlab1:
  yyerrstatus = 3;      /* Each real token shifted decrements this.  */

  for (;;)
    {
      yyn = yypact[yystate];
      if (!yypact_value_is_default (yyn))
        {
          yyn += YYTERROR;
          if (0 <= yyn && yyn <= YYLAST && yycheck[yyn] == YYTERROR)
            {
              yyn = yytable[yyn];
              if (0 < yyn)
                break;
            }
        }

      /* Pop the current state because it cannot handle the error token.  */
      if (yyssp == yyss)
        YYABORT;


      yydestruct ("Error: popping",
                  yystos[yystate], yyvsp);
      YYPOPSTACK (1);
      yystate = *yyssp;
      YY_STACK_PRINT (yyss, yyssp);
    }

  YY_IGNORE_MAYBE_UNINITIALIZED_BEGIN
  *++yyvsp = yylval;
  YY_IGNORE_MAYBE_UNINITIALIZED_END


  /* Shift the error token.  */
  YY_SYMBOL_PRINT ("Shifting", yystos[yyn], yyvsp, yylsp);

  yystate = yyn;
  goto yynewstate;


/*-------------------------------------.
| yyacceptlab -- YYACCEPT comes here.  |
`-------------------------------------*/
yyacceptlab:
  yyresult = 0;
  goto yyreturn;

/*-----------------------------------.
| yyabortlab -- YYABORT comes here.  |
`-----------------------------------*/
yyabortlab:
  yyresult = 1;
  goto yyreturn;

#if !defined yyoverflow || YYERROR_VERBOSE
/*-------------------------------------------------.
| yyexhaustedlab -- memory exhaustion comes here.  |
`-------------------------------------------------*/
yyexhaustedlab:
  yyerror (YY_("memory exhausted"));
  yyresult = 2;
  /* Fall through.  */
#endif

yyreturn:
  if (yychar != YYEMPTY)
    {
      /* Make sure we have latest lookahead translation.  See comments at
         user semantic actions for why this is necessary.  */
      yytoken = YYTRANSLATE (yychar);
      yydestruct ("Cleanup: discarding lookahead",
                  yytoken, &yylval);
    }
  /* Do not reclaim the symbols of the rule whose action triggered
     this YYABORT or YYACCEPT.  */
  YYPOPSTACK (yylen);
  YY_STACK_PRINT (yyss, yyssp);
  while (yyssp != yyss)
    {
      yydestruct ("Cleanup: popping",
                  yystos[*yyssp], yyvsp);
      YYPOPSTACK (1);
    }
#ifndef yyoverflow
  if (yyss != yyssa)
    YYSTACK_FREE (yyss);
#endif
#if YYERROR_VERBOSE
  if (yymsg != yymsgbuf)
    YYSTACK_FREE (yymsg);
#endif
  return yyresult;
}
#line 793 "../../bc/bc.y" /* yacc.c:1906  */

