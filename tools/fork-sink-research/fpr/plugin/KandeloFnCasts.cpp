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
#include <map>
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


// ---------------------------------------------------------------- slots
//
// Per-slot tracking of untyped pointers (the precise form of the opaque
// pool). A slot is a place an untyped value (void *, char *, a pointer-
// sized integer) can live:
//   l:<fn>:<var>  local      p:<fn>:<k>  parameter     r:<fn>  return value
//   g:<var>       global     f:<rec>.<field>  field (unions: f:<union>.*)
//   pt:<type>:<k> parameter of any function of type   rt:<type>  its return
//   v:<fn>        the variadic arguments of fn         *  unknown
// Origins are what an untyped value can carry:
//   @rec:<R>  a pointer to record R (holding function pointers)
//   @fn:<f>   function f's address   @ty:<T>  some function of type T
// Lines:
//   SE  from to        a value flows from slot/origin `from` into slot `to`
//   SO  slot record    the slot's value is read back as a pointer to record
//   SF  slot type      the slot's value is read back as a function of type
//   SD  slot type      memory the slot points to is read as a function of type
//   SL  type k fn      function fn has type `type`; its parameter k (or `ret`)
//                      is the slot pt:type:k (rt:type) for indirect calls
//   FT  record type    record has a function-pointer field of this type
//   NR  record inner   record embeds record `inner`
// The analysis propagates origins along SE edges; an origin read back as a
// different record or function type is a call through another type.
class SlotVisitor : public RecursiveASTVisitor<SlotVisitor> {
public:
  SlotVisitor(ASTContext &C) : Ctx(C), MC(C.createMangleContext()) {}

  bool TraverseFunctionDecl(FunctionDecl *F) {
    const FunctionDecl *Saved = Cur;
    Cur = F;
    if (F->doesThisDeclarationHaveABody()) declareFunction(F);
    bool r = RecursiveASTVisitor::TraverseFunctionDecl(F);
    Cur = Saved;
    return r;
  }
  bool TraverseCXXMethodDecl(CXXMethodDecl *F) {
    const FunctionDecl *Saved = Cur;
    Cur = F;
    if (F->doesThisDeclarationHaveABody()) declareFunction(F);
    bool r = RecursiveASTVisitor::TraverseCXXMethodDecl(F);
    Cur = Saved;
    return r;
  }

  bool VisitVarDecl(VarDecl *V) {
    if (isa<ParmVarDecl>(V) || !V->hasInit()) return true;
    if (isTracked(V->getType())) flow(V->getInit(), varSlot(V));
    return true;
  }

  bool VisitBinaryOperator(BinaryOperator *E) {
    if (E->getOpcode() != BO_Assign) return true;
    const Expr *L = E->getLHS()->IgnoreParenImpCasts();
    std::string t = targetSlot(L);
    if (t.empty()) return true;
    if (isTracked(L->getType())) flow(E->getRHS(), t);
    else if (fnPtr(L->getType()) && isUnionField(L)) {
      // A function stored through a union member: any member may read it.
      for (const std::string &o : fnOrigins(E->getRHS())) edge(o, t);
    }
    return true;
  }

  bool VisitInitListExpr(InitListExpr *E) {
    if (!E->isSemanticForm() && E->getSemanticForm()) E = E->getSemanticForm();
    const RecordType *RT = E->getType()->getAs<RecordType>();
    if (!RT) return true;
    const RecordDecl *R = RT->getDecl();
    unsigned i = 0;
    for (const FieldDecl *F : R->fields()) {
      if (i >= E->getNumInits()) break;
      const Expr *I = E->getInit(i++);
      std::string t = fieldSlot(R, F);
      if (isTracked(F->getType())) flow(I, t);
      else if (R->isUnion() && fnPtr(F->getType()))
        for (const std::string &o : fnOrigins(I)) edge(o, t);
      if (R->isUnion()) break; // a union initializes one member
    }
    return true;
  }

  bool VisitCallExpr(CallExpr *E) {
    const FunctionDecl *FD = E->getDirectCallee();
    std::string base;
    unsigned nparams = 0;
    bool variadic = false;
    const FunctionProtoType *Proto = nullptr;
    if (FD) {
      base = "p:" + name(FD) + ":";
      nparams = FD->getNumParams();
      variadic = FD->isVariadic();
      Proto = FD->getType()->getAs<FunctionProtoType>();
    } else if (const FunctionType *FT = calleeType(E)) {
      base = "pt:" + mangleType(QualType(FT, 0)) + ":";
      Proto = dyn_cast<FunctionProtoType>(FT);
      nparams = Proto ? Proto->getNumParams() : 0;
      variadic = Proto ? Proto->isVariadic() : true;
    } else {
      return true;
    }
    for (unsigned i = 0; i < E->getNumArgs(); ++i) {
      const Expr *A = E->getArg(i);
      if (i < nparams) {
        QualType PT = FD ? FD->getParamDecl(i)->getType() : Proto->getParamType(i);
        if (isTracked(PT)) flow(A, base + std::to_string(i));
      } else if (variadic) {
        flow(A, FD ? "v:" + name(FD) : std::string("*"));
      }
    }
    // memcpy between a record and untyped memory moves the record's
    // contents through the untyped pointer.
    if (FD && FD->getIdentifier() && E->getNumArgs() >= 2) {
      llvm::StringRef n = FD->getName();
      if (n == "memcpy" || n == "memmove" || n == "__builtin_memcpy" || n == "__builtin_memmove" || n == "bcopy") {
        const Expr *D = E->getArg(n == "bcopy" ? 1 : 0)->IgnoreParenImpCasts(), *S2 = E->getArg(n == "bcopy" ? 0 : 1)->IgnoreParenImpCasts();
        const RecordDecl *RD = pointeeRecord(D->getType()), *RS = pointeeRecord(S2->getType());
        if (RS && holdsFnPointers(RS) && !RD) {
          describe(RS);
          flowOrigin("@rec:" + recordName(RS), D);
        }
        if (RD && holdsFnPointers(RD) && !RS)
          for (const std::string &src : sources(S2)) readAsRecord(src, RD);
        // Untyped to untyped (realloc's copy, buffer shuffles): whatever the
        // source memory held, the destination memory now holds.
        if (!RD && !RS)
          for (const std::string &src : sources(S2))
            for (const std::string &dst : sources(D)) edge(src, dst);
      }
    }
    return true;
  }

  bool VisitReturnStmt(ReturnStmt *S) {
    if (!Cur || !S->getRetValue() || !isTracked(Cur->getReturnType())) return true;
    flow(S->getRetValue(), "r:" + name(Cur));
    return true;
  }

  bool VisitCastExpr(CastExpr *E) {
    const Expr *Sub = E->getSubExpr();
    QualType From = Sub->getType(), To = E->getType();
    if (!isTracked(From)) return true;
    // Read back as a record holding function pointers.
    if (const RecordDecl *R = pointeeRecord(To); R && holdsFnPointers(R) && !isNull(Sub)) {
      for (const std::string &s : sources(Sub)) readAsRecord(s, R);
      return true;
    }
    // Read back as a function pointer.
    if (const FunctionType *FT = fnPtr(To); FT && !isNull(Sub)) {
      std::string ty = mangleType(QualType(FT, 0));
      for (const std::string &s : sources(Sub)) add("SF\t" + s + "\t" + ty);
      return true;
    }
    // Read as `t **`: the memory it points to holds functions of type t.
    if (To->isPointerType()) {
      QualType PT = To->getPointeeType().getCanonicalType();
      if (const FunctionType *FE = fnPtr(PT); FE && !isNull(Sub)) {
        std::string ty = mangleType(QualType(FE, 0));
        for (const std::string &s : sources(Sub)) add("SD\t" + s + "\t" + ty);
      }
    }
    return true;
  }

  bool VisitMemberExpr(MemberExpr *E) {
    // A union's function-pointer member read: whatever any member stored.
    const auto *F = dyn_cast<FieldDecl>(E->getMemberDecl());
    if (!F || !F->getParent()->isUnion()) return true;
    if (const FunctionType *FT = fnPtr(F->getType()))
      add("SF\t" + fieldSlot(F->getParent(), F) + "\t" + mangleType(QualType(FT, 0)));
    return true;
  }

  bool VisitVAArgExpr(VAArgExpr *E) {
    // va_arg reads the variadic arguments of the enclosing function.
    if (Cur && isTracked(E->getType())) VaReads.insert(E);
    return true;
  }

private:
  ASTContext &Ctx;
  std::unique_ptr<MangleContext> MC;
  const FunctionDecl *Cur = nullptr;
  std::set<std::string> Seen;
  std::set<const Expr *> VaReads;
  std::set<const RecordDecl *> Described;

  void add(const std::string &line) {
    if (Seen.insert(line).second) kandeloAstFacts() += line + "\n";
  }
  void edge(const std::string &from, const std::string &to) {
    if (!from.empty() && !to.empty() && from != to) add("SE\t" + from + "\t" + to);
  }
  void flow(const Expr *E, const std::string &to) {
    for (const std::string &s : sources(E)) edge(s, to);
  }
  void flowOrigin(const std::string &origin, const Expr *Dst) {
    // memcpy(untyped dst, &record, n): the record's contents now sit in the
    // memory dst points to; model it as the record's pointer flowing there.
    for (const std::string &s : sources(Dst)) edge(origin, s);
  }
  void readAsRecord(const std::string &slot, const RecordDecl *R) {
    describe(R);
    add("SO\t" + slot + "\t" + recordName(R));
  }
  void describe(const RecordDecl *R, int depth = 0) {
    if (!R || depth > 4 || !(R = R->getDefinition()) || !Described.insert(R).second) return;
    for (const FieldDecl *F : R->fields()) {
      QualType T = F->getType().getCanonicalType();
      while (const auto *A = dyn_cast<ArrayType>(T.getTypePtr())) T = A->getElementType().getCanonicalType();
      if (const FunctionType *FT = fnPtr(T)) add("FT\t" + recordName(R) + "\t" + mangleType(QualType(FT, 0)));
      else if (const auto *RT = T->getAs<RecordType>()) {
        add("NR\t" + recordName(R) + "\t" + recordName(RT->getDecl()));
        describe(RT->getDecl(), depth + 1);
      }
    }
  }

  void declareFunction(const FunctionDecl *F) {
    std::string ty = mangleType(F->getType());
    std::string n = name(F);
    for (unsigned i = 0; i < F->getNumParams(); ++i)
      if (isTracked(F->getParamDecl(i)->getType())) add("SL\t" + ty + "\t" + std::to_string(i) + "\t" + n);
    if (isTracked(F->getReturnType())) add("SL\t" + ty + "\tret\t" + n);
  }

  // Untyped: void *, char * (any signedness/cv), or a pointer-sized integer
  // type spelled as one (intptr_t, uintptr_t, size_t, long, ...).
  bool isTracked(QualType T) const {
    T = T.getCanonicalType();
    if (T->isPointerType()) {
      QualType P = T->getPointeeType().getCanonicalType();
      return P->isVoidType() || P->isCharType();
    }
    if (T->isIntegerType() && !T->isBooleanType() && !T->isEnumeralType())
      return Ctx.getTypeSize(T) == Ctx.getTypeSize(Ctx.VoidPtrTy) && !T->isSpecificBuiltinType(BuiltinType::Int) &&
             !T->isSpecificBuiltinType(BuiltinType::UInt);
    return false;
  }

  static const FunctionType *fnPtr(QualType T) {
    T = T.getCanonicalType();
    if (const auto *P = T->getAs<PointerType>()) return P->getPointeeType()->getAs<FunctionType>();
    return nullptr;
  }
  static bool isUnionField(const Expr *L) {
    const auto *M = dyn_cast<MemberExpr>(L);
    const auto *F = M ? dyn_cast<FieldDecl>(M->getMemberDecl()) : nullptr;
    return F && F->getParent()->isUnion();
  }

  const FunctionType *calleeType(const CallExpr *E) const {
    QualType T = E->getCallee()->getType().getCanonicalType();
    if (const auto *P = T->getAs<PointerType>()) T = P->getPointeeType();
    return T->getAs<FunctionType>();
  }

  std::string varSlot(const VarDecl *V) {
    if (const auto *P = dyn_cast<ParmVarDecl>(V)) {
      const auto *F = dyn_cast<FunctionDecl>(P->getDeclContext());
      return F ? "p:" + name(F) + ":" + std::to_string(P->getFunctionScopeIndex()) : "*";
    }
    if (V->hasGlobalStorage() && !V->isStaticLocal()) return "g:" + V->getName().str();
    return "l:" + (Cur ? name(Cur) : std::string("?")) + ":" + V->getName().str();
  }
  std::string fieldSlot(const RecordDecl *R, const FieldDecl *F) {
    if (R->isUnion()) return "f:" + recordName(R) + ".*";
    std::string fn = F->getName().str();
    if (fn.empty()) fn = "#" + std::to_string(F->getFieldIndex());
    return "f:" + recordName(R) + "." + fn;
  }
  // Where an assignment's left side stores.
  std::string targetSlot(const Expr *L) {
    if (const auto *D = dyn_cast<DeclRefExpr>(L)) {
      if (const auto *V = dyn_cast<VarDecl>(D->getDecl())) return varSlot(V);
      return "";
    }
    if (const auto *M = dyn_cast<MemberExpr>(L)) {
      if (const auto *F = dyn_cast<FieldDecl>(M->getMemberDecl())) return fieldSlot(F->getParent(), F);
      return "";
    }
    // *pp = v, a[i] = v: memory we do not name.
    return "*";
  }

  // Function origins of a function-pointer-typed expression.
  std::vector<std::string> fnOrigins(const Expr *E) {
    if (const FunctionDecl *FD = refFn(E)) return {"@fn:" + name(FD)};
    if (const FunctionType *FT = fnPtr(E->IgnoreParenImpCasts()->getType())) return {"@ty:" + mangleType(QualType(FT, 0))};
    return {"*"};
  }

  // Where an untyped value comes from: slots and origins.
  std::vector<std::string> sources(const Expr *E, int depth = 0) {
    if (!E || depth > 16) return {"*"};
    E = E->IgnoreParens();
    if (isNull(E)) return {};
    if (const auto *C = dyn_cast<CastExpr>(E)) {
      const Expr *Sub = C->getSubExpr();
      QualType From = Sub->getType();
      if (const RecordDecl *R = pointeeRecord(From)) {
        if (!holdsFnPointers(R)) return {};
        describe(R);
        return {"@rec:" + recordName(R)};
      }
      if (From->isFunctionType() || fnPtr(From)) return fnOrigins(Sub);
      if (isTracked(From)) return sources(Sub, depth + 1);
      if (From->isIntegerType() || From->isPointerType()) {
        // A plain int or a pointer to data without functions carries no
        // tracked origin unless it was itself derived from one.
        if (From->isIntegerType() && !isa<IntegerLiteral>(Sub->IgnoreParenCasts())) return sources(Sub, depth + 1);
        return {};
      }
      return {};
    }
    if (const auto *D = dyn_cast<DeclRefExpr>(E)) {
      if (const auto *V = dyn_cast<VarDecl>(D->getDecl())) return {varSlot(V)};
      return {};
    }
    if (const auto *M = dyn_cast<MemberExpr>(E)) {
      if (const auto *F = dyn_cast<FieldDecl>(M->getMemberDecl())) return {fieldSlot(F->getParent(), F)};
      return {"*"};
    }
    if (const auto *C = dyn_cast<CallExpr>(E)) {
      // Standard functions that return (a pointer into) one of their
      // arguments: the result is that argument at this call, not a slot
      // shared by every caller (memset's return would otherwise merge every
      // memset destination in the program).
      if (const FunctionDecl *FD = C->getDirectCallee(); FD && FD->getIdentifier()) {
        static const std::map<std::string, unsigned> kReturnsArg = {
            {"memset", 0}, {"memcpy", 0}, {"memmove", 0}, {"memccpy", 0}, {"strcpy", 0}, {"strncpy", 0},
            {"strcat", 0}, {"strncat", 0}, {"stpcpy", 0}, {"stpncpy", 0}, {"strchr", 0}, {"strrchr", 0},
            {"strchrnul", 0}, {"memchr", 0}, {"memrchr", 0}, {"rawmemchr", 0}, {"strstr", 0}, {"strpbrk", 0},
            {"__builtin_memset", 0}, {"__builtin_memcpy", 0}, {"__builtin_memmove", 0}, {"__builtin_strcpy", 0}};
        auto it = kReturnsArg.find(FD->getName().str());
        if (it != kReturnsArg.end() && it->second < C->getNumArgs()) return sources(C->getArg(it->second), depth + 1);
      }
      if (const FunctionDecl *FD = C->getDirectCallee()) return {"r:" + name(FD)};
      if (const FunctionType *FT = calleeType(C)) return {"rt:" + mangleType(QualType(FT, 0))};
      return {"*"};
    }
    if (const auto *B = dyn_cast<BinaryOperator>(E)) {
      if (B->getOpcode() == BO_Comma) return sources(B->getRHS(), depth + 1);
      if (B->isAdditiveOp() || B->isBitwiseOp() || B->getOpcode() == BO_Assign) {
        std::vector<std::string> v = sources(B->getLHS(), depth + 1), w = sources(B->getRHS(), depth + 1);
        v.insert(v.end(), w.begin(), w.end());
        return v;
      }
      return {};
    }
    if (const auto *Cond = dyn_cast<AbstractConditionalOperator>(E)) {
      std::vector<std::string> v = sources(Cond->getTrueExpr(), depth + 1), w = sources(Cond->getFalseExpr(), depth + 1);
      v.insert(v.end(), w.begin(), w.end());
      return v;
    }
    if (isa<VAArgExpr>(E)) return {Cur ? "v:" + name(Cur) : std::string("*")};
    if (isa<IntegerLiteral>(E) || isa<CharacterLiteral>(E) || isa<StringLiteral>(E) || isa<SizeOfPackExpr>(E) ||
        isa<UnaryExprOrTypeTraitExpr>(E))
      return {};
    if (const auto *U = dyn_cast<UnaryOperator>(E)) {
      // &x of untyped storage, or arithmetic on an untyped value.
      if (U->getOpcode() == UO_AddrOf) return {};
      if (U->isIncrementDecrementOp() || U->getOpcode() == UO_Minus || U->getOpcode() == UO_Not || U->getOpcode() == UO_Plus)
        return sources(U->getSubExpr(), depth + 1);
    }
    // *pp, a[i], statement expressions, ...: memory we do not name.
    return {"*"};
  }

  static const FunctionDecl *refFn(const Expr *E) {
    E = E->IgnoreParenCasts();
    if (const auto *U = dyn_cast<UnaryOperator>(E); U && U->getOpcode() == UO_AddrOf) E = U->getSubExpr()->IgnoreParenCasts();
    if (const auto *D = dyn_cast<DeclRefExpr>(E)) return dyn_cast<FunctionDecl>(D->getDecl());
    if (const auto *M = dyn_cast<MemberExpr>(E)) return dyn_cast<FunctionDecl>(M->getMemberDecl());
    return nullptr;
  }
  static bool isNull(const Expr *E) {
    E = E->IgnoreParenCasts();
    return isa<CXXNullPtrLiteralExpr>(E) || isa<GNUNullExpr>(E) ||
           (isa<IntegerLiteral>(E) && cast<IntegerLiteral>(E)->getValue() == 0);
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
    SlotVisitor SV(C);
    SV.TraverseDecl(C.getTranslationUnitDecl());
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
