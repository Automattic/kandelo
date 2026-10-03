// KandeloFnCasts: the Clang (AST) half of the KandeloCallTypes plugin.
//
// Research tool for fork sinks (docs/plans/2026-10-02-fork-sinks.md,
// "Type-unsafe function pointers"). The fork-path analysis matches an
// indirect call to a target by exact C/C++ function type (CFI type ids).
// That is only safe for functions whose address never reaches a call
// through a different function type. Such a type change is visible in the
// source before LLVM's opaque pointers erase it, so this pass records every
// place it can happen. The analysis matches the functions involved by Wasm
// signature (today's rule) and every other function exactly.
//
// Lines, appended to the side file by the LLVM pass (same dylib, same
// process; this consumer runs before code generation):
//   Q	fn	type        fn's address is taken here; type = its function type
//   W	fn	to          fn's address is converted to function type `to`, or to
//                      a non-function type (`*`: void *, an integer, ...)
//   Z	from	to      a function-pointer value of type `from` (not a direct
//                      reference) is converted to `to`; `*` = not a function
//                      type (e.g. void * converted back to a function pointer)
//   G	fn	record      fn's address is stored in a field of `record`
//                      (initializer or member assignment)
//   H	record	to      a pointer to `record`, which holds function pointers,
//                      is converted to a pointer to a different non-void type
//                      (struct punning): its functions may be called as `to`.
//                      `to` is the function type the destination designates
//                      (`void (**)(void)` -> void(void)), each function-pointer
//                      field type of a destination record, or `*`.
// The opaque pool. Memory that passes through `void *`, `char *` or an
// integer loses its type, so the pass models it as one pool:
//   - a record holding function pointers whose pointer is converted to or
//     from such a type enters the pool: `J record` (its functions may be
//     read back as anything in the pool) and `U t` for each of its
//     function-pointer field types t (anything in the pool may be read back
//     as t);
//   - a union holding function pointers is always in the pool (its members
//     alias by definition);
//   - a non-matching pointer converted to `t **` reads the pool as t
//     (`U t`).
// `J`/`U` are separate from `H`/`Z` so the analysis can measure the pool's
// cost on its own (fpa `--rule pool`).
// Fresh allocations (malloc, operator new, ...) hold no functions, and
// `memset`/`free`-style calls or a `memcpy` between two pointers to the same
// type do not move functions between types; they do not enter the pool.
// Types are clang's canonical type mangling (the CFI type id string, e.g.
// _ZTSFvPvE); names are demangled like the LLVM pass's names.
#include "clang/AST/ASTConsumer.h"
#include "clang/AST/ASTContext.h"
#include "clang/AST/Expr.h"
#include "clang/AST/Mangle.h"
#include "clang/AST/RecursiveASTVisitor.h"
#include "clang/Frontend/CompilerInstance.h"
#include "clang/Frontend/FrontendPluginRegistry.h"
#include "llvm/Demangle/Demangle.h"
#include "llvm/Support/raw_ostream.h"
#include <memory>
#include <set>
#include <string>

using namespace clang;

std::string &kandeloAstFacts() {
  static std::string s;
  return s;
}

namespace {

// The function type a value of type T designates or points to, if any.
const FunctionType *fnType(QualType T) {
  T = T.getCanonicalType();
  if (const auto *R = T->getAs<ReferenceType>()) T = R->getPointeeType().getCanonicalType();
  if (const auto *P = T->getAs<PointerType>()) T = P->getPointeeType().getCanonicalType();
  else if (const auto *M = T->getAs<MemberPointerType>()) T = M->getPointeeType().getCanonicalType();
  return T->getAs<FunctionType>();
}

// Does record R hold a function pointer (directly, in an array, or in a
// nested record)?
bool holdsFnPointers(const RecordDecl *R, int depth = 0) {
  if (!R || depth > 4) return false;
  R = R->getDefinition();
  if (!R) return false;
  for (const FieldDecl *F : R->fields()) {
    QualType T = F->getType().getCanonicalType();
    while (const auto *A = dyn_cast<ArrayType>(T.getTypePtr())) T = A->getElementType().getCanonicalType();
    if (fnType(T) && !T->isFunctionType()) return true;
    if (const auto *RT = T->getAs<RecordType>())
      if (holdsFnPointers(RT->getDecl(), depth + 1)) return true;
  }
  return false;
}

const RecordDecl *pointeeRecord(QualType T) {
  T = T.getCanonicalType();
  if (const auto *P = T->getAs<PointerType>())
    if (const auto *RT = P->getPointeeType()->getAs<RecordType>()) return RT->getDecl();
  return nullptr;
}

class Visitor : public RecursiveASTVisitor<Visitor> {
public:
  Visitor(ASTContext &C) : Ctx(C), MC(C.createMangleContext()) {}

  bool VisitCastExpr(CastExpr *E) {
    QualType From = E->getSubExpr()->getType(), To = E->getType();
    const FunctionType *FF = fnType(From), *FT = fnType(To);
    if (FF || FT) {
      if (FF && FT && Ctx.hasSameType(QualType(FF, 0), QualType(FT, 0))) return true;
      std::string to = FT ? mangleType(QualType(FT, 0)) : "*";
      if (const FunctionDecl *FD = referencedFn(E->getSubExpr())) {
        add("W\t" + name(FD) + "\t" + to);
      } else {
        add("Z\t" + (FF ? mangleType(QualType(FF, 0)) : std::string("*")) + "\t" + to);
      }
      return true;
    }
    // `(t **) p` from a pointer to anything else reads the pool as t.
    if (To->isPointerType()) {
      QualType PT = To->getPointeeType().getCanonicalType();
      const FunctionType *FE = fnType(PT);
      if (FE && !PT->isFunctionType() && !SafeArg.count(E) && !isNull(E->getSubExpr()) &&
          !(From->isPointerType() && Ctx.hasSameType(From->getPointeeType().getCanonicalType(), PT)))
        add("U\t" + mangleType(QualType(FE, 0)));
    }
    // The opaque pool: a record holding function pointers converted to or
    // from void *, char * or an integer.
    if (!SafeArg.count(E)) {
      const RecordDecl *RIn = pointeeRecord(From), *ROut = pointeeRecord(To);
      if (RIn && holdsFnPointers(RIn) && isOpaque(To)) pool(RIn);
      if (ROut && holdsFnPointers(ROut) && isOpaque(From) && !isFresh(E->getSubExpr()) && !isNull(E->getSubExpr()))
        pool(ROut);
    }
    // Struct punning: a pointer to a record that holds function pointers
    // converted to a pointer to some other non-void, non-char type.
    const RecordDecl *RF = pointeeRecord(From);
    if (RF && holdsFnPointers(RF) && To->isPointerType()) {
      QualType PT = To->getPointeeType().getCanonicalType();
      const RecordDecl *RT = pointeeRecord(To);
      bool same = RT && RT->getCanonicalDecl() == RF->getCanonicalDecl();
      bool opaque = PT->isVoidType() || PT->isCharType();
      // A derived-to-base C++ conversion is not punning.
      bool base = E->getCastKind() == CK_DerivedToBase || E->getCastKind() == CK_UncheckedDerivedToBase ||
                  E->getCastKind() == CK_BaseToDerived;
      if (!same && !opaque && !base) {
        std::set<std::string> tos;
        QualType E2 = PT;
        while (const auto *A = dyn_cast<ArrayType>(E2.getTypePtr())) E2 = A->getElementType().getCanonicalType();
        if (const FunctionType *FE = fnType(E2); FE && !E2->isFunctionType())
          tos.insert(mangleType(QualType(FE, 0)));
        else if (RT)
          fieldFnTypes(RT, tos);
        if (tos.empty()) tos.insert("*");
        for (const std::string &t : tos) add("H\t" + recordName(RF) + "\t" + t);
      }
    }
    return true;
  }

  bool VisitDeclRefExpr(DeclRefExpr *E) {
    // Q: every address-taken function and its type. Direct callees are
    // filtered by the parent check in TraverseCallExpr below.
    if (const auto *FD = dyn_cast<FunctionDecl>(E->getDecl()))
      if (!InCallee.count(E)) add("Q\t" + name(FD) + "\t" + mangleType(FD->getType()));
    return true;
  }

  bool VisitCallExpr(CallExpr *E) {
    if (const Expr *C = E->getCallee())
      if (const auto *D = dyn_cast<DeclRefExpr>(C->IgnoreParenImpCasts())) InCallee.insert(D);
    // Arguments of calls that never move a function between types.
    const FunctionDecl *FD = E->getDirectCallee();
    if (!FD || !FD->getIdentifier()) return true;
    llvm::StringRef n = FD->getName();
    static const std::set<std::string> kNoMove = {
        "free", "memset", "bzero", "explicit_bzero", "memcmp", "munmap", "g_free", "cfree", "__builtin_memset"};
    auto markArgs = [&] {
      for (Expr *A : E->arguments())
        if (auto *IC = dyn_cast<ImplicitCastExpr>(A)) SafeArg.insert(IC);
    };
    if (kNoMove.count(n.str())) markArgs();
    if ((n == "memcpy" || n == "memmove" || n == "__builtin_memcpy" || n == "__builtin_memmove") && E->getNumArgs() >= 2) {
      QualType D = E->getArg(0)->IgnoreParenImpCasts()->getType(), S2 = E->getArg(1)->IgnoreParenImpCasts()->getType();
      if (D->isPointerType() && S2->isPointerType() &&
          Ctx.hasSameUnqualifiedType(D->getPointeeType(), S2->getPointeeType()))
        markArgs();
    }
    return true;
  }

  bool VisitRecordDecl(RecordDecl *R) {
    // Union members alias: whatever is stored through one may be read
    // through another.
    if (R->isUnion() && R->isCompleteDefinition() && holdsFnPointers(R)) pool(R);
    return true;
  }

  bool VisitInitListExpr(InitListExpr *E) {
    // The traversal visits the syntactic form (designators intact); the
    // semantic form lists each field's initializer in field order.
    if (!E->isSemanticForm() && E->getSemanticForm()) E = E->getSemanticForm();
    const RecordType *RT = E->getType()->getAs<RecordType>();
    if (!RT) return true;
    for (unsigned i = 0; i < E->getNumInits(); ++i)
      if (const FunctionDecl *FD = referencedFn(E->getInit(i)))
        add("G\t" + name(FD) + "\t" + recordName(RT->getDecl()));
    return true;
  }

  bool VisitBinaryOperator(BinaryOperator *E) {
    if (!E->isAssignmentOp()) return true;
    const auto *M = dyn_cast<MemberExpr>(E->getLHS()->IgnoreParenImpCasts());
    if (!M) return true;
    const FunctionDecl *FD = referencedFn(E->getRHS());
    if (!FD) return true;
    QualType B = M->getBase()->getType();
    if (M->isArrow() && B->isPointerType()) B = B->getPointeeType();
    if (const auto *RT = B->getAs<RecordType>()) add("G\t" + name(FD) + "\t" + recordName(RT->getDecl()));
    return true;
  }

  // Visit callees before the DeclRefExprs inside them.
  bool TraverseCallExpr(CallExpr *E) {
    VisitCallExpr(E);
    return RecursiveASTVisitor::TraverseCallExpr(E);
  }

private:
  ASTContext &Ctx;
  std::unique_ptr<MangleContext> MC;
  std::set<const DeclRefExpr *> InCallee;
  std::set<std::string> Seen;
  std::set<const Expr *> SafeArg;

  // Enter the opaque pool (see the header).
  void pool(const RecordDecl *R) {
    std::set<std::string> ts;
    fieldFnTypes(R, ts);
    add("J\t" + recordName(R));
    for (const std::string &t : ts) add("U\t" + t);
    // Nested records' functions are R's functions too.
    if ((R = R->getDefinition()))
      for (const FieldDecl *F : R->fields()) {
        QualType T = F->getType().getCanonicalType();
        while (const auto *A = dyn_cast<ArrayType>(T.getTypePtr())) T = A->getElementType().getCanonicalType();
        if (const auto *RT = T->getAs<RecordType>(); RT && holdsFnPointers(RT->getDecl()))
          add("J\t" + recordName(RT->getDecl()));
      }
  }

  static bool isOpaque(QualType T) {
    T = T.getCanonicalType();
    if (T->isIntegerType()) return true;
    if (!T->isPointerType()) return false;
    QualType P = T->getPointeeType().getCanonicalType();
    return P->isVoidType() || P->isCharType();
  }

  static bool isNull(const Expr *E) {
    E = E->IgnoreParenCasts();
    return isa<CXXNullPtrLiteralExpr>(E) || isa<GNUNullExpr>(E) ||
           (isa<IntegerLiteral>(E) && cast<IntegerLiteral>(E)->getValue() == 0);
  }

  // Fresh memory holds no functions.
  static bool isFresh(const Expr *E) {
    E = E->IgnoreParenCasts();
    if (isa<CXXNewExpr>(E)) return true;
    const auto *C = dyn_cast<CallExpr>(E);
    const FunctionDecl *FD = C ? C->getDirectCallee() : nullptr;
    if (!FD) return false;
    if (FD->getOverloadedOperator() == OO_New || FD->getOverloadedOperator() == OO_Array_New) return true;
    if (!FD->getIdentifier()) return false;
    static const std::set<std::string> kAlloc = {
        "malloc", "calloc", "realloc", "aligned_alloc", "memalign", "valloc", "alloca", "__builtin_alloca",
        "g_malloc", "g_malloc0", "g_realloc", "g_try_malloc", "g_try_malloc0", "g_slice_alloc", "g_slice_alloc0",
        "mmap", "operator new"};
    return kAlloc.count(FD->getName().str());
  }

  // Function types of R's function-pointer fields (arrays, nested records).
  void fieldFnTypes(const RecordDecl *R, std::set<std::string> &out, int depth = 0) {
    if (!R || depth > 4 || !(R = R->getDefinition())) return;
    for (const FieldDecl *F : R->fields()) {
      QualType T = F->getType().getCanonicalType();
      while (const auto *A = dyn_cast<ArrayType>(T.getTypePtr())) T = A->getElementType().getCanonicalType();
      if (const FunctionType *FT = fnType(T); FT && !T->isFunctionType()) out.insert(mangleType(QualType(FT, 0)));
      else if (const auto *RT = T->getAs<RecordType>()) fieldFnTypes(RT->getDecl(), out, depth + 1);
    }
  }

  void add(const std::string &line) {
    if (Seen.insert(line).second) kandeloAstFacts() += line + "\n";
  }

  static const FunctionDecl *referencedFn(const Expr *E) {
    E = E->IgnoreParenCasts();
    if (const auto *U = dyn_cast<UnaryOperator>(E); U && U->getOpcode() == UO_AddrOf)
      E = U->getSubExpr()->IgnoreParenCasts();
    if (const auto *D = dyn_cast<DeclRefExpr>(E)) return dyn_cast<FunctionDecl>(D->getDecl());
    if (const auto *M = dyn_cast<MemberExpr>(E)) return dyn_cast<FunctionDecl>(M->getMemberDecl());
    return nullptr;
  }

  std::string mangleType(QualType T) {
    std::string s;
    llvm::raw_string_ostream os(s);
    MC->mangleCanonicalTypeName(T.getCanonicalType(), os);
    return s;
  }

  std::string name(const FunctionDecl *FD) {
    if (isa<CXXConstructorDecl>(FD) || isa<CXXDestructorDecl>(FD)) return FD->getQualifiedNameAsString();
    std::string s;
    if (MC->shouldMangleDeclName(FD)) {
      llvm::raw_string_ostream os(s);
      MC->mangleName(GlobalDecl(FD), os);
      return llvm::demangle(s);
    }
    return FD->getName().str();
  }

  static std::string recordName(const RecordDecl *R) {
    std::string n = R->getQualifiedNameAsString();
    return n.empty() ? "<anon>" : n;
  }
};

class Consumer : public ASTConsumer {
public:
  void HandleTranslationUnit(ASTContext &C) override {
    Visitor V(C);
    V.TraverseDecl(C.getTranslationUnitDecl());
  }
};

class Action : public PluginASTAction {
protected:
  std::unique_ptr<ASTConsumer> CreateASTConsumer(CompilerInstance &, llvm::StringRef) override {
    return std::make_unique<Consumer>();
  }
  bool ParseArgs(const CompilerInstance &, const std::vector<std::string> &) override { return true; }
  // Before the main action, so the facts exist when code generation runs the
  // LLVM pass that writes the side file.
  ActionType getActionType() override { return AddBeforeMainAction; }
};

} // namespace

static FrontendPluginRegistry::Add<Action> X("kandelo-fncasts", "record type-unsafe function pointer conversions");
