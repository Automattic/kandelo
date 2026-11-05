// Generated from the unchanged pinned node_sqlite.h limit table.
#ifndef KANDELO_SQLITE_LIMIT_NAMES_H
#define KANDELO_SQLITE_LIMIT_NAMES_H
#include <array>
#include <sqlite3.h>
#include <string_view>
namespace kandelo::sqlite {
struct LimitInfo {
  std::string_view js_name;
  int sqlite_limit_id;
};

inline constexpr std::array<LimitInfo, 11> kLimitMapping = {{
    {"length", SQLITE_LIMIT_LENGTH},
    {"sqlLength", SQLITE_LIMIT_SQL_LENGTH},
    {"column", SQLITE_LIMIT_COLUMN},
    {"exprDepth", SQLITE_LIMIT_EXPR_DEPTH},
    {"compoundSelect", SQLITE_LIMIT_COMPOUND_SELECT},
    {"vdbeOp", SQLITE_LIMIT_VDBE_OP},
    {"functionArg", SQLITE_LIMIT_FUNCTION_ARG},
    {"attach", SQLITE_LIMIT_ATTACHED},
    {"likePatternLength", SQLITE_LIMIT_LIKE_PATTERN_LENGTH},
    {"variableNumber", SQLITE_LIMIT_VARIABLE_NUMBER},
    {"triggerDepth", SQLITE_LIMIT_TRIGGER_DEPTH},
}};
static_assert(SQLITE_LIMIT_LENGTH == 0);
static_assert(SQLITE_LIMIT_SQL_LENGTH == 1);
static_assert(SQLITE_LIMIT_COLUMN == 2);
static_assert(SQLITE_LIMIT_EXPR_DEPTH == 3);
static_assert(SQLITE_LIMIT_COMPOUND_SELECT == 4);
static_assert(SQLITE_LIMIT_VDBE_OP == 5);
static_assert(SQLITE_LIMIT_FUNCTION_ARG == 6);
static_assert(SQLITE_LIMIT_ATTACHED == 7);
static_assert(SQLITE_LIMIT_LIKE_PATTERN_LENGTH == 8);
static_assert(SQLITE_LIMIT_VARIABLE_NUMBER == 9);
static_assert(SQLITE_LIMIT_TRIGGER_DEPTH == 10);
}
#endif
