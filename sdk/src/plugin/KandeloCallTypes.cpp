// KandeloCallTypes: an out-of-tree LLVM pass plugin (clang -fpass-plugin),
// built and loaded by the Kandelo SDK for every C/C++ compile
// (sdk/src/lib/calltypes-plugin.ts, docs/sdk-guide.md "Compiler facts").
//
// It gives wasm-fork-instrument source-level facts about calls without
// changing the code that ships (docs/plans/2026-10-02-fork-sinks.md).
//
// 1. Pipeline start (before any optimization): clang has emitted CFI type
//    tests (-Xclang -fsanitize=cfi-icall plus -fwhole-program-vtables). For
//    every indirect call guarded by a test, attach the test's type id to the
//    call as metadata (!kandelo.icall / !kandelo.vcall), then delete the test
//    so the optimizer sees the same IR as an ordinary build. Metadata on
//    calls survives inlining and cloning.
// 2. Optimizer last (just before code generation): describe every remaining
//    call, every function's type ids, every vtable slot, constant and
//    pass-through call arguments, and which call sites stay reachable when
//    one integer parameter has a known value. The AST half
//    (KandeloFnCasts.cpp, same dylib and process) appends its lines.
//
// Output: the text below is carried by a Wasm custom section named
// `kandelo.calltypes` in the object file (through the WebAssembly backend's
// `wasm.custom_sections` named metadata). WHY a section and not a side file:
// the facts must travel with the object through static archives, copies and
// caches, and wasm-ld concatenates same-named custom sections of every
// linked object in input order, so a linked module carries the facts of
// exactly the code it contains. Every translation unit emits one, even if it
// holds only the header and M line, so a missing unit is distinguishable
// from an empty one. `-mllvm -kandelo-calltypes-out=<path>` also writes the
// same text to a file (debugging only).
// Chunks at least 1 MiB are stored losslessly as zlib frames: magic
// KCTZ\0\0\0\1, little-endian uint64 decoded and encoded sizes, then the
// compressed bytes. The instrumenter decodes each frame before reading the
// unchanged format-5 records; wasm-ld concatenates plain/framed chunks alike.
//
// Format (TSV, demangled names matching the wasm name section):
//   #kandelo-calltypes	5
//   M	module-id        the main source file, remapped by -ffile-prefix-map /
//        -fmacro-prefix-map like __FILE__ so objects stay path-independent
//   F	fn	nparams	linkage(E|I)	addr-taken(0|1)	mangled
//   T	fn	typeid                       function type id (offset 0 only);
//        an internal-linkage type id is `L:<module-id>:<n>`, n numbering the
//        module's distinct ids in first-use order
//   V	fn	classid	offset               vtable slot
//   C	fn	site	callee               direct call (aliases resolved)
//   S	fn	site	wasm-sig	icall	typeid
//   S	fn	site	wasm-sig	vcall	classid	offset
//   S	fn	site	wasm-sig	untyped
//   A	fn	site	arg	c	width	value   constant integer argument (unsigned)
//   A	fn	site	arg	p	param            argument is the caller's parameter
//   K	fn	param	width	value|*	sites   call sites reachable from entry
//        when the parameter equals value (`*` = equals none of the values
//        the function compares it with). Absent = every site reachable.
//   D	fn	nindirect	ncalls
//   R	registry	fn|*|?   a callback passed to a standard registration
//        API (* = not a known function, ? = the API's address escapes)
//   R	registry	%N	mangled-fn   the enclosing function forwards its
//        parameter N to a registration API
//   X	fn	kind	detail   where an address-taken function's address goes:
//        field <struct>:<index> (stored into a struct field, or a struct
//        field of a global initializer), arg <callee>:<index>, ret,
//        global <name> (a non-struct global initializer), other
//   P	fn	param	kind	detail   the same for a pointer parameter's value
//   Y	fn	site	kind	detail   where an indirect call's callee was loaded
//        from: field <struct>:<index>, global <name>, arg <index>, other
//   O	global                         holds only already-installed handlers
// followed by the AST half's lines (see KandeloFnCasts.cpp).
// Sites number every non-intrinsic call in instruction order.
#include "llvm/Analysis/ConstantFolding.h"
#include "llvm/Demangle/Demangle.h"
#include "llvm/IR/CFG.h"
#include "llvm/IR/Constants.h"
#include "llvm/IR/InstIterator.h"
#include "llvm/IR/Instructions.h"
#include "llvm/IR/IntrinsicInst.h"
#include "llvm/IR/Module.h"
#include "llvm/IR/Operator.h"
#include "llvm/IR/PassManager.h"
#include "llvm/Passes/PassBuilder.h"
#include "llvm/Passes/PassPlugin.h"
#include "llvm/Support/CommandLine.h"
#include "llvm/Support/Compression.h"
#include "llvm/Support/Endian.h"
#include "llvm/Support/FileSystem.h"
#include "llvm/Support/raw_ostream.h"
#include "llvm/Transforms/Utils/BasicBlockUtils.h"
#include <functional>
#include <map>
#include <set>

using namespace llvm;

// Source-level facts from KandeloFnCasts.cpp (same dylib, same process).
std::string &kandeloAstFacts();
// The main file name remapped by the prefix maps (empty: no AST half ran).
std::string &kandeloModuleId();
// A sanitizer other than the plugin's cfi-icall is enabled (AST half).
bool &kandeloOtherSanitizers();

static cl::opt<std::string> OutPath("kandelo-calltypes-out", cl::init(""),
                                    cl::desc("Also write the Kandelo call-type facts to this file (debugging)"));

static const char kSectionName[] = "kandelo.calltypes";

namespace {

// The unit's identity in the facts: the remapped main file when the AST half
// ran (path-independent objects), else LLVM's module identifier.
std::string moduleId(const Module &M) {
  return kandeloModuleId().empty() ? M.getModuleIdentifier() : kandeloModuleId();
}

// Numbers for distinct (internal-linkage) type ids, assigned in first-use
// order while EmitPass writes one module. WHY not the node's address: the
// facts are object-file bytes now, and an address differs on every run.
std::map<const Metadata *, unsigned> &localTypeIds() {
  static std::map<const Metadata *, unsigned> m;
  return m;
}

std::string typeIdString(Metadata *MD, const Module &M) {
  if (auto *S = dyn_cast<MDString>(MD)) return S->getString().str();
  // Distinct (internal-linkage) type ids are unique per module.
  auto &ids = localTypeIds();
  auto it = ids.try_emplace(MD, ids.size()).first;
  return "L:" + moduleId(M) + ":" + std::to_string(it->second);
}

// Values tested by llvm.type.test, through phi/select.
void testedTypes(Value *V, std::map<Value *, std::vector<Metadata *>> &tests,
                 std::vector<Metadata *> &out, bool &ok, int depth = 0) {
  if (!ok) return;
  auto it = tests.find(V);
  if (it != tests.end()) { out.insert(out.end(), it->second.begin(), it->second.end()); return; }
  if (depth < 8) {
    if (auto *P = dyn_cast<PHINode>(V)) {
      for (Value *in : P->incoming_values()) testedTypes(in, tests, out, ok, depth + 1);
      return;
    }
    if (auto *S = dyn_cast<SelectInst>(V)) {
      testedTypes(S->getTrueValue(), tests, out, ok, depth + 1);
      testedTypes(S->getFalseValue(), tests, out, ok, depth + 1);
      return;
    }
  }
  ok = false;
}

// The function a call targets directly, looking through aliases.
Function *directCallee(CallBase *CB) {
  if (Function *F = CB->getCalledFunction()) return F;
  Value *V = CB->getCalledOperand()->stripPointerCasts();
  if (auto *GA = dyn_cast<GlobalAlias>(V)) return dyn_cast_or_null<Function>(GA->getAliaseeObject());
  return dyn_cast<Function>(V);
}

// Opaque pointers have no bitcasts; strip address-space casts only. (LLVM's
// stripPointerCasts also strips all-zero GEPs, which would erase field 0.)
static Value *stripCastsOnly(Value *V) {
  while (auto *C = dyn_cast<AddrSpaceCastOperator>(V)) V = C->getOperand(0);
  return V;
}

// Struct field addressed by a pointer: "<struct>:<field>" or "".
std::string fieldOf(Value *P) {
  P = stripCastsOnly(P);
  auto *G = dyn_cast<GEPOperator>(P);
  if (!G) {
    if (auto *AI = dyn_cast<AllocaInst>(P); AI && AI->getAllocatedType()->isStructTy())
      return AI->getAllocatedType()->getStructName().str() + ":0";
    if (auto *GV = dyn_cast<GlobalVariable>(P); GV && GV->getValueType()->isStructTy())
      return GV->getValueType()->getStructName().str() + ":0";
    return "";
  }
  Type *T = G->getSourceElementType();
  // gep T, p, 0, i (, ...): the first struct level after the leading index.
  if (G->getNumIndices() >= 2 && T->isStructTy()) {
    if (auto *CI = dyn_cast<ConstantInt>(G->getOperand(2)))
      return T->getStructName().str() + ":" + std::to_string(CI->getZExtValue());
  }
  return "";
}

// Pre-optimization IR keeps locals in allocas: look through one level of
// `store v, %local; ... load %local` to the stored value's origin.
Value *throughLocal(Value *V) {
  auto *L = dyn_cast<LoadInst>(stripCastsOnly(V));
  if (!L) return V;
  auto *AI = dyn_cast<AllocaInst>(stripCastsOnly(L->getPointerOperand()));
  if (!AI) return V;
  Value *Stored = nullptr;
  for (User *U : AI->users()) {
    if (auto *SI = dyn_cast<StoreInst>(U)) {
      if (stripCastsOnly(SI->getPointerOperand()) != AI) return V;
      if (Stored && Stored != SI->getValueOperand()) return V;
      Stored = SI->getValueOperand();
    }
  }
  return Stored ? Stored : V;
}

std::string loadOrigin(Value *C) {
  C = stripCastsOnly(throughLocal(C));
  auto *L = dyn_cast<LoadInst>(C);
  if (!L) return isa<Argument>(C) ? "arg\t" + std::to_string(cast<Argument>(C)->getArgNo()) : "other\t";
  Value *P = stripCastsOnly(throughLocal(L->getPointerOperand()));
  if (auto *GV = dyn_cast<GlobalVariable>(P)) return "global\t" + GV->getName().str();
  std::string f = fieldOf(P);
  if (!f.empty()) return "field\t" + f;
  return "other\t";
}

// Where each use of an address-taken function sends its address.
void addressRecords(Value &Root, const std::string &prefix, raw_ostream &os,
                    const std::function<std::string(StringRef)> &nm) {
  std::set<std::string> seen;
  std::set<Value *> visited;
  auto emit = [&](const std::string &kind, const std::string &detail) {
    std::string k = kind + "\t" + detail;
    if (seen.insert(k).second) os << prefix << k << "\n";
  };
  std::function<void(Value *, int)> walk = [&](Value *V, int depth) {
    if (!visited.insert(V).second) return;
    for (Use &U : V->uses()) {
      User *Us = U.getUser();
      if (auto *CB = dyn_cast<CallBase>(Us)) {
        if (CB->isCallee(&U)) continue;
        Function *Callee = directCallee(CB);
        if (!CB->isArgOperand(&U)) emit("other", "call-operand");
        else if (Callee) emit("arg", nm(Callee->getName()) + ":" + std::to_string(CB->getArgOperandNo(&U)));
        else emit("other", "indirect-call-arg");
      } else if (auto *SI = dyn_cast<StoreInst>(Us)) {
        if (SI->getValueOperand() != V) { emit("other", "store-address"); continue; }
        Value *Ptr = stripCastsOnly(SI->getPointerOperand());
        if (auto *AI = dyn_cast<AllocaInst>(Ptr); AI && !AI->getAllocatedType()->isStructTy() && depth < 6) {
          // A local variable: follow its loads.
          for (User *LU : AI->users())
            if (auto *LI = dyn_cast<LoadInst>(LU)) walk(LI, depth + 1);
          continue;
        }
        std::string f = fieldOf(SI->getPointerOperand());
        if (!f.empty()) emit("field", f);
        else if (auto *GV = dyn_cast<GlobalVariable>(stripCastsOnly(SI->getPointerOperand()))) emit("global", GV->getName().str());
        else emit("other", "store");
      } else if (isa<ReturnInst>(Us)) {
        emit("ret", "");
      } else if (isa<ICmpInst>(Us)) {
        continue;
      } else if (auto *CE = dyn_cast<ConstantExpr>(Us); CE && depth < 4 && CE->isCast()) {
        walk(CE, depth + 1);
      } else if ((isa<BitCastInst>(Us) || isa<PHINode>(Us) || isa<SelectInst>(Us)) && depth < 6) {
        walk(Us, depth + 1);
      } else if (auto *C = dyn_cast<Constant>(Us)) {
        // Part of a global initializer: find the struct and field.
        bool done = false;
        if (auto *CS = dyn_cast<ConstantStruct>(C)) {
          for (unsigned i = 0; i < CS->getNumOperands(); ++i)
            if (stripCastsOnly(CS->getOperand(i)) == stripCastsOnly(V)) {
              StructType *ST = CS->getType();
              emit("field", (ST->hasName() ? ST->getName().str() : std::string("anon")) + ":" + std::to_string(i));
              done = true;
            }
        }
        if (!done) {
          if (isa<ConstantArray>(C) || isa<ConstantVector>(C)) {
            // An array element: classify by the arrays' users.
            if (depth < 4) walk(C, depth + 1); else emit("other", "array");
          } else if (auto *GV = dyn_cast<GlobalVariable>(C)) {
            emit("global", GV->getName().str());
          } else {
            emit("other", "constant");
          }
        }
      } else if (auto *GV = dyn_cast<GlobalVariable>(Us)) {
        emit("global", GV->getName().str());
      } else {
        emit("other", Us->getValueID() < Value::InstructionVal ? "value" : cast<Instruction>(Us)->getOpcodeName());
      }
    }
  };
  walk(&Root, 0);
}

// Flow facts gathered before optimization, written by EmitPass.
std::map<const Module *, std::string> &flowFacts() {
  static std::map<const Module *, std::string> m;
  return m;
}

struct TagPass : PassInfoMixin<TagPass> {
  PreservedAnalyses run(Module &M, ModuleAnalysisManager &) {
    LLVMContext &Ctx = M.getContext();
    bool changed = false;
    {
      // Flow facts need struct-typed field addressing, which the optimizer
      // canonicalizes away: collect them now. Indirect calls carry their
      // callee's origin as metadata, which survives inlining.
      std::string buf;
      raw_string_ostream fo(buf);
      auto nm = [](StringRef n) { return demangle(n.str()); };
      for (Function &Fn : M) {
        if (Fn.isIntrinsic()) continue;
        bool taken = false;
        for (const Use &U : Fn.uses()) {
          auto *CB = dyn_cast<CallBase>(U.getUser());
          if (!(CB && CB->isCallee(&U))) { taken = true; break; }
        }
        if (taken) addressRecords(Fn, "X\t" + nm(Fn.getName()) + "\t", fo, nm);
        if (Fn.isDeclaration()) continue;
        for (Argument &A : Fn.args())
          if (A.getType()->isPointerTy())
            addressRecords(A, "P\t" + nm(Fn.getName()) + "\t" + std::to_string(A.getArgNo()) + "\t", fo, nm);
        for (Instruction &I : instructions(Fn)) {
          auto *CB = dyn_cast<CallBase>(&I);
          if (!CB || CB->getCalledFunction() || CB->isInlineAsm() || isa<IntrinsicInst>(CB)) continue;
          if (directCallee(CB)) continue;
          CB->setMetadata("kandelo.origin", MDNode::get(Ctx, {MDString::get(Ctx, loadOrigin(CB->getCalledOperand()))}));
          changed = true;
        }
      }
      flowFacts()[&M] = fo.str();
    }
    for (Function &F : M) {
      if (F.isDeclaration()) continue;
      std::map<Value *, std::vector<Metadata *>> tests;
      std::vector<CallInst *> dead;
      for (Instruction &I : instructions(F)) {
        auto *II = dyn_cast<IntrinsicInst>(&I);
        if (!II) continue;
        if (II->getIntrinsicID() == Intrinsic::type_test ||
            II->getIntrinsicID() == Intrinsic::public_type_test) {
          Value *P = II->getArgOperand(0)->stripPointerCasts();
          auto *MDV = cast<MetadataAsValue>(II->getArgOperand(1));
          tests[P].push_back(MDV->getMetadata());
          dead.push_back(II);
        }
      }
      if (dead.empty()) continue;
      for (Instruction &I : instructions(F)) {
        auto *CB = dyn_cast<CallBase>(&I);
        if (!CB || CB->getCalledFunction() || CB->isInlineAsm()) continue;
        Value *C = CB->getCalledOperand()->stripPointerCasts();
        std::vector<Metadata *> ts;
        bool ok = true;
        testedTypes(C, tests, ts, ok);
        if (ok && !ts.empty()) {
          std::vector<Metadata *> ops(ts.begin(), ts.end());
          CB->setMetadata("kandelo.icall", MDNode::get(Ctx, ops));
          continue;
        }
        // Virtual call: callee = load (gep vtable, K), vtable tested.
        auto *L = dyn_cast<LoadInst>(C);
        if (!L) continue;
        Value *Addr = L->getPointerOperand();
        int64_t K = 0;
        if (auto *G = dyn_cast<GEPOperator>(Addr)) {
          APInt Off(M.getDataLayout().getIndexTypeSizeInBits(G->getType()), 0);
          if (!G->accumulateConstantOffset(M.getDataLayout(), Off)) continue;
          K = Off.getSExtValue();
          Addr = G->getPointerOperand();
        }
        ts.clear(); ok = true;
        testedTypes(Addr->stripPointerCasts(), tests, ts, ok);
        if (!ok || ts.empty()) continue;
        std::vector<Metadata *> ops;
        for (Metadata *T : ts) {
          ops.push_back(T);
          ops.push_back(ConstantAsMetadata::get(ConstantInt::get(Type::getInt64Ty(Ctx), K)));
        }
        CB->setMetadata("kandelo.vcall", MDNode::get(Ctx, ops));
      }
      F.setMetadata("kandelo.hadtests", MDNode::get(Ctx, {}));
      // Delete the tests: the optimizer must see an ordinary build.
      std::vector<BranchInst *> checks;
      for (CallInst *T : dead) {
        for (User *U : T->users())
          if (auto *BI = dyn_cast<BranchInst>(U); BI && BI->isConditional() && isTrapBlock(BI->getSuccessor(1)))
            checks.push_back(BI);
        T->replaceAllUsesWith(ConstantInt::getTrue(Ctx));
        T->eraseFromParent();
      }
      // A cfi-icall check is `br %test, %cont, %trap` with %cont split off
      // the call's block. Without optimization nothing folds it, so restore
      // the block clang emits without the check (code at -O0 would
      // otherwise keep the dead trap).
      for (BranchInst *BI : checks) {
        BasicBlock *Cont = BI->getSuccessor(0), *Trap = BI->getSuccessor(1);
        Trap->removePredecessor(BI->getParent());
        BranchInst::Create(Cont, BI->getIterator());
        BI->eraseFromParent();
        if (pred_empty(Trap)) DeleteDeadBlock(Trap);
        MergeBlockIntoPredecessor(Cont);
      }
      changed = true;
    }
    // The checks' static data (source locations, type descriptors) is
    // emitted even in trap mode, where nothing references it; the optimizer
    // drops it, -O0 would ship it. Only when cfi-icall is the sole sanitizer:
    // another sanitizer's unused data is part of the ordinary build.
    if (!kandeloOtherSanitizers()) {
      for (GlobalVariable &G : make_early_inc_range(M.globals())) {
        if (!G.hasPrivateLinkage() || !G.isConstant()) continue;
        G.removeDeadConstantUsers(); // the check's unused source-location struct
        if (!G.use_empty()) continue;
        auto *ST = dyn_cast<StructType>(G.getValueType());
        bool descriptor = !G.hasName() && ST && ST->getNumElements() == 3 && ST->getElementType(0)->isIntegerTy(16) &&
                          ST->getElementType(1)->isIntegerTy(16) && ST->getElementType(2)->isArrayTy();
        if (G.getName().starts_with(".src") || descriptor) {
          G.eraseFromParent();
          changed = true;
        }
      }
    }
    return changed ? PreservedAnalyses::none() : PreservedAnalyses::all();
  }

  // clang's trap-mode check failure block: a trap intrinsic, then unreachable.
  static bool isTrapBlock(BasicBlock *B) {
    auto *II = dyn_cast<IntrinsicInst>(&B->front());
    return II && (II->getIntrinsicID() == Intrinsic::ubsantrap || II->getIntrinsicID() == Intrinsic::trap) &&
           isa<UnreachableInst>(II->getNextNode());
  }
};

std::string wasmVal(Type *T, const DataLayout &DL, bool &ok) {
  if (T->isPointerTy()) return DL.getPointerSizeInBits() == 64 ? "i64" : "i32";
  if (T->isIntegerTy()) {
    unsigned w = T->getIntegerBitWidth();
    if (w <= 32) return "i32";
    if (w == 64) return "i64";
    if (w == 128) return "i64,i64";
  }
  if (T->isFloatTy()) return "f32";
  if (T->isDoubleTy()) return "f64";
  if (T->isVectorTy() && DL.getTypeSizeInBits(T) == 128) return "v128";
  ok = false;
  return "?";
}

std::string wasmSig(FunctionType *FT, const DataLayout &DL) {
  bool ok = true;
  std::string p;
  for (Type *T : FT->params()) {
    if (!p.empty()) p += ",";
    p += wasmVal(T, DL, ok);
  }
  if (FT->isVarArg()) { if (!p.empty()) p += ","; p += DL.getPointerSizeInBits() == 64 ? "i64" : "i32"; }
  std::string r = FT->getReturnType()->isVoidTy() ? "" : wasmVal(FT->getReturnType(), DL, ok);
  return ok ? p + "->" + r : "?";
}

// Standard callback-registration APIs: (callee symbol, argument, registry).
// libc/libc++ later call these callbacks through generic dispatch sites; the
// analysis lets those sites reach only registered functions.
struct RegistryArg { const char *callee; unsigned arg; const char *registry; };
const RegistryArg kRegistries[] = {
    {"pthread_key_create", 1, "tsd"}, {"__pthread_key_create", 1, "tsd"},
    {"atexit", 0, "exit"}, {"__cxa_atexit", 0, "exit"}, {"at_quick_exit", 0, "exit"},
    {"__cxa_thread_atexit", 0, "exit"}, {"__cxa_thread_atexit_impl", 0, "exit"},
    {"pthread_once", 1, "once"}, {"__pthread_once", 1, "once"}, {"call_once", 1, "once"},
    {"pthread_create", 2, "thread"}, {"__pthread_create", 2, "thread"}, {"thrd_create", 1, "thread"},
    {"qsort", 3, "cmp"}, {"qsort_r", 3, "cmp"}, {"__qsort_r", 3, "cmp"}, {"bsearch", 4, "cmp"},
    {"_pthread_cleanup_push", 1, "cleanup"},
    {"pthread_atfork", 0, "atfork"}, {"pthread_atfork", 1, "atfork"}, {"pthread_atfork", 2, "atfork"},
    {"signal", 1, "signal"}, {"bsd_signal", 1, "signal"}, {"sigset", 1, "signal"},
    {"_ZSt13set_terminatePFvvE", 0, "terminate"},
    {"_ZSt14set_unexpectedPFvvE", 0, "unexpected"},
    {"_ZSt15set_new_handlerPFvvE", 0, "new_handler"},
    {"__synccall", 0, "synccall"},
};

// sigaction-style APIs: (callee, act argument, old argument).
struct SigactionApi { const char *callee; unsigned act; unsigned old; };
const SigactionApi kSigaction[] = {
    {"sigaction", 1, 2}, {"__sigaction", 1, 2}, {"__libc_sigaction", 1, 2},
};


// Short description of how an untyped callee value was produced.
std::string describe(Value *V, int depth = 0) {
  V = V->stripPointerCasts();
  std::string s;
  raw_string_ostream os(s);
  if (auto *I = dyn_cast<Instruction>(V)) {
    os << I->getOpcodeName();
    if (auto *L = dyn_cast<LoadInst>(I)) {
      Value *P = L->getPointerOperand()->stripPointerCasts();
      if (auto *G = dyn_cast<GlobalValue>(P)) os << "@" << demangle(G->getName().str());
      else if (depth < 2) os << "(" << describe(P, depth + 1) << ")";
    } else if (auto *G = dyn_cast<GetElementPtrInst>(I)) {
      os << "<" << *G->getSourceElementType() << ">";
      if (depth < 2) os << "(" << describe(G->getPointerOperand(), depth + 1) << ")";
    } else if (auto *C = dyn_cast<CallBase>(I)) {
      if (Function *F = C->getCalledFunction()) os << "@" << demangle(F->getName().str());
    }
  } else if (isa<Argument>(V)) {
    os << "arg";
  } else if (auto *G = dyn_cast<GlobalValue>(V)) {
    os << "@" << demangle(G->getName().str());
  } else {
    os << "value";
  }
  std::string r = os.str();
  for (char &c : r) if (c == '\t' || c == '\n') c = ' ';
  return r.size() > 200 ? r.substr(0, 200) : r;
}

bool isSite(Instruction &I) {
  auto *CB = dyn_cast<CallBase>(&I);
  if (!CB || CB->isInlineAsm() || isa<IntrinsicInst>(CB)) return false;
  return true;
}

// Cast chains from a parameter to a compared value.
struct Use1 { Value *V; bool injective; };

void castUses(Value *P, bool injective, int depth, std::vector<Use1> &out) {
  out.push_back({P, injective});
  if (depth >= 3) return;
  for (User *U : P->users()) {
    auto *CI = dyn_cast<CastInst>(U);
    if (!CI || !CI->getType()->isIntegerTy()) continue;
    if (isa<ZExtInst>(CI) || isa<SExtInst>(CI)) castUses(CI, injective, depth + 1, out);
    else if (isa<TruncInst>(CI)) castUses(CI, false, depth + 1, out);
  }
}

// Evaluate V with the parameter fixed, folding only pure integer operations.
// Returns null when the value is not a known constant.
Constant *evalWith(Value *V, Argument *P, Constant *PV, const DataLayout &DL,
                   std::map<Value *, Constant *> &memo, int depth = 0) {
  if (V == P) return PV;
  if (auto *C = dyn_cast<Constant>(V)) return isa<ConstantExpr>(C) ? nullptr : C;
  auto it = memo.find(V);
  if (it != memo.end()) return it->second;
  Constant *R = nullptr;
  auto *I = dyn_cast<Instruction>(V);
  if (I && depth < 16 && !I->mayReadOrWriteMemory() && !isa<PHINode>(I) && !isa<CallBase>(I) &&
      (isa<CastInst>(I) || isa<BinaryOperator>(I) || isa<CmpInst>(I) || isa<SelectInst>(I)) &&
      I->getType()->isIntegerTy()) {
    SmallVector<Constant *, 4> ops;
    bool all = true;
    for (Value *O : I->operands()) {
      Constant *C = evalWith(O, P, PV, DL, memo, depth + 1);
      if (!C) { all = false; break; }
      ops.push_back(C);
    }
    if (all) R = ConstantFoldInstOperands(I, ops, DL);
    if (R && !isa<ConstantInt>(R)) R = nullptr;
  }
  memo[V] = R;
  return R;
}

// Blocks reachable from entry with parameter P == PV (PV null: P equals
// none of the values in `cands`; only injective eq/ne/switch tests fold).
std::set<BasicBlock *> reachable(Function &F, Argument *P, Constant *PV,
                                 const std::set<Value *> &injectiveUses,
                                 const std::set<uint64_t> &cands, const DataLayout &DL) {
  std::map<Value *, Constant *> memo;
  std::set<BasicBlock *> seen;
  std::vector<BasicBlock *> work{&F.getEntryBlock()};
  // For the `*` case: V is an injective (zext/sext) chain of P, so V == K
  // only if P == trunc(K). Every such trunc(K) is a candidate, and in this
  // case P equals no candidate, so V differs from K.
  auto starDiffers = [&](Value *V, ConstantInt *K) -> bool {
    if (PV || !injectiveUses.count(V)) return false;
    unsigned w = P->getType()->getIntegerBitWidth();
    if (K->getBitWidth() < w) return false;
    return cands.count(K->getValue().trunc(w).getZExtValue()) != 0;
  };
  while (!work.empty()) {
    BasicBlock *B = work.back();
    work.pop_back();
    if (!seen.insert(B).second) continue;
    Instruction *T = B->getTerminator();
    if (!T) continue;
    if (auto *Br = dyn_cast<BranchInst>(T); Br && Br->isConditional()) {
      Value *C = Br->getCondition();
      if (PV) {
        if (auto *K = dyn_cast_or_null<ConstantInt>(evalWith(C, P, PV, DL, memo))) {
          work.push_back(Br->getSuccessor(K->isOne() ? 0 : 1));
          continue;
        }
      } else if (auto *IC = dyn_cast<ICmpInst>(C); IC && IC->isEquality()) {
        auto *K = dyn_cast<ConstantInt>(IC->getOperand(1));
        if (K && starDiffers(IC->getOperand(0), K)) {
          bool eq = IC->getPredicate() == ICmpInst::ICMP_EQ;
          work.push_back(Br->getSuccessor(eq ? 1 : 0));
          continue;
        }
      }
    } else if (auto *Sw = dyn_cast<SwitchInst>(T)) {
      if (PV) {
        if (auto *K = dyn_cast_or_null<ConstantInt>(evalWith(Sw->getCondition(), P, PV, DL, memo))) {
          work.push_back(Sw->findCaseValue(K)->getCaseSuccessor());
          continue;
        }
      } else if (injectiveUses.count(Sw->getCondition())) {
        bool all = true;
        for (auto &Case : Sw->cases()) all &= starDiffers(Sw->getCondition(), Case.getCaseValue());
        if (all) { work.push_back(Sw->getDefaultDest()); continue; }
      }
    }
    for (BasicBlock *S : successors(B)) work.push_back(S);
  }
  return seen;
}

// A file-local `struct sigaction` global written only by sigaction() as its
// `old` argument (forkfd's old_sigaction): it can only ever hold a handler
// that was already installed (or SIG_DFL/SIG_IGN). Calling through it, or
// passing it back as `act` to restore it, installs nothing new.
bool oldactOnly(GlobalVariable *GV) {
  if (!GV->hasLocalLinkage() || GV->isConstant()) return false;
  bool asOld = false;
  std::function<bool(Value *, int)> ok = [&](Value *P, int depth) -> bool {
    for (User *U : P->users()) {
      if (isa<LoadInst>(U) || isa<ICmpInst>(U)) continue;
      if (auto *G = dyn_cast<GEPOperator>(U)) {
        if (depth > 4 || !ok(G, depth + 1)) return false;
        continue;
      }
      if (auto *CB = dyn_cast<CallBase>(U)) {
        Function *C = directCallee(CB);
        bool hit = false;
        for (const SigactionApi &SA : kSigaction) {
          if (!C || C->getName() != SA.callee) continue;
          for (unsigned a = 0; a < CB->arg_size(); ++a) {
            if (CB->getArgOperand(a)->stripPointerCasts() != P) continue;
            if (a == SA.old) { asOld = true; hit = true; }
            else if (a == SA.act) hit = true;
          }
        }
        if (hit) continue;
      }
      return false;
    }
    return true;
  };
  return ok(GV, 0) && asOld;
}

// The handler (offset 0) of a constant `struct sigaction` initializer.
Value *initHandler(Constant *C) {
  while (C && (isa<ConstantStruct>(C) || isa<ConstantArray>(C)) && C->getNumOperands())
    C = cast<Constant>(C->getOperand(0));
  return C ? C->stripPointerCasts() : nullptr;
}

// sigaction(sig, act, old): record the handlers stored into *act.
void sigactionRecords(Value *Act, Function &F, raw_ostream &os, const std::function<std::string(StringRef)> &nm) {
  Act = Act->stripPointerCasts();
  if (isa<ConstantPointerNull>(Act)) return;
  // A forwarder (musl's own sigaction layers) passes its caller's struct.
  if (auto *A = dyn_cast<Argument>(Act); A && A->getParent() == &F) {
    StringRef n = F.getName();
    if (n == "sigaction" || n == "__sigaction" || n == "__libc_sigaction") return;
    os << "R\tsignal\t*\n";
    return;
  }
  if (auto *GV = dyn_cast<GlobalVariable>(Act)) {
    if (oldactOnly(GV)) return; // restoring an already-installed handler
    if (GV->hasInitializer())
      if (auto *CS = dyn_cast<ConstantStruct>(GV->getInitializer()))
        if (CS->getNumOperands() && isa<Function>(CS->getOperand(0)->stripPointerCasts()))
          os << "R\tsignal\t" << nm(CS->getOperand(0)->stripPointerCasts()->getName()) << "\n";
    if (!GV->isConstant()) os << "R\tsignal\t*\n";
    return;
  }
  if (!isa<AllocaInst>(Act)) { os << "R\tsignal\t*\n"; return; }
  // Stores into the alloca at offset 0 (the handler union).
  bool any = false;
  std::function<void(Value *, int64_t, int)> walk = [&](Value *P, int64_t off, int depth) {
    for (User *U : P->users()) {
      if (auto *SI = dyn_cast<StoreInst>(U)) {
        if (SI->getPointerOperand() != P) { os << "R\tsignal\t*\n"; continue; }
        if (off != 0) continue;
        Value *V = SI->getValueOperand()->stripPointerCasts();
        if (!V->getType()->isPointerTy() && !V->getType()->isIntegerTy(32)) continue;
        if (auto *Fn = dyn_cast<Function>(V)) { os << "R\tsignal\t" << nm(Fn->getName()) << "\n"; any = true; }
        else if (isa<Constant>(V) && !isa<GlobalValue>(V)) continue;
        else if (auto *A = dyn_cast<Argument>(V); A && A->getParent() == &F &&
                 (F.getName() == "signal" || F.getName() == "bsd_signal" || F.getName() == "sigset")) continue;
        else if (auto *A = dyn_cast<Argument>(V); A && A->getParent() == &F && F.hasLocalLinkage() && !F.hasAddressTaken()) {
          // A file-local forwarder (Qt's change_sigpipe(SIG_IGN)): the
          // handlers are whatever its callers pass.
          for (User *FU : F.users()) {
            auto *FC = dyn_cast<CallBase>(FU);
            if (!FC || FC->getCalledFunction() != &F || A->getArgNo() >= FC->arg_size()) { os << "R\tsignal\t*\n"; continue; }
            Value *X = FC->getArgOperand(A->getArgNo())->stripPointerCasts();
            if (auto *XF = dyn_cast<Function>(X)) os << "R\tsignal\t" << nm(XF->getName()) << "\n";
            else if (!(isa<Constant>(X) && !isa<GlobalValue>(X))) os << "R\tsignal\t*\n";
          }
        }
        else os << "R\tsignal\t*\n";
      } else if (auto *G = dyn_cast<GEPOperator>(U)) {
        APInt O(64, 0);
        if (depth < 4 && G->accumulateConstantOffset(F.getParent()->getDataLayout(), O)) walk(G, off + O.getSExtValue(), depth + 1);
        else os << "R\tsignal\t*\n";
      } else if (auto *CB = dyn_cast<CallBase>(U)) {
        Function *C = directCallee(CB);
        StringRef cn = C ? C->getName() : "";
        // sigaction(act/old), memset, lifetime markers and sigemptyset/sigaddset
        // (which write sa_mask) do not store a handler.
        // `struct sigaction sa = { .sa_handler = handler }` may be a memcpy
        // from a constant initializer (musl's __synccall).
        if (cn.starts_with("llvm.memcpy") && CB->getArgOperand(0)->stripPointerCasts() == P) {
          auto *Src = dyn_cast<GlobalVariable>(CB->getArgOperand(1)->stripPointerCasts());
          Value *H = (off == 0 && Src && Src->isConstant() && Src->hasInitializer()) ? initHandler(Src->getInitializer()) : nullptr;
          if (auto *HF = dyn_cast_or_null<Function>(H)) os << "R\tsignal\t" << nm(HF->getName()) << "\n";
          else if (!(H && isa<Constant>(H) && !isa<GlobalValue>(H))) os << "R\tsignal\t*\n";
          continue;
        }
        if (cn == "sigaction" || cn == "__sigaction" || cn == "__libc_sigaction" || cn == "memset" ||
            cn.starts_with("llvm.lifetime") || cn.starts_with("llvm.memset") || cn == "sigemptyset" ||
            cn == "sigfillset" || cn == "sigaddset" || cn == "sigdelset")
          continue;
        os << "R\tsignal\t*\n";
      } else if (isa<LoadInst>(U) || isa<ICmpInst>(U)) {
        continue;
      } else {
        os << "R\tsignal\t*\n";
      }
    }
  };
  walk(Act, 0, 0);
  (void)any;
}

struct EmitPass : PassInfoMixin<EmitPass> {
  PreservedAnalyses run(Module &M, ModuleAnalysisManager &) {
    std::string text;
    raw_string_ostream os(text);
    localTypeIds().clear();
    const DataLayout &DL = M.getDataLayout();
    auto nm = [](StringRef n) { return demangle(n.str()); };
    os << "#kandelo-calltypes\t5\n";
    os << "M\t" << moduleId(M) << "\n";
    // Registration APIs whose address escapes (called indirectly or stored)
    // make their registry unknown.
    for (const RegistryArg &R : kRegistries) {
      Function *F = M.getFunction(R.callee);
      if (!F) continue;
      for (const Use &U : F->uses()) {
        auto *CB = dyn_cast<CallBase>(U.getUser());
        if (CB && CB->isCallee(&U)) continue;
        // `if (&pthread_create)`-style weak-symbol checks do not escape.
        if (isa<ICmpInst>(U.getUser())) continue;
        // musl's weak_alias(__pthread_once, pthread_once): an alias is the
        // same API under another name, not an escape of its address.
        if (isa<GlobalAlias>(U.getUser())) continue;
        os << "R\t" << R.registry << "\t?\n";
        break;
      }
    }
    for (Function &F : M) {
      if (F.isDeclaration()) continue;
      std::string fn = nm(F.getName());
      os << "F\t" << fn << "\t" << F.arg_size() << "\t" << (F.hasLocalLinkage() ? "I" : "E") << "\t"
         << (F.hasAddressTaken() ? 1 : 0) << "\t" << F.getName() << "\n";
      SmallVector<MDNode *, 2> types;
      F.getMetadata(LLVMContext::MD_type, types);
      for (MDNode *T : types) {
        auto *Off = mdconst::dyn_extract<ConstantInt>(T->getOperand(0));
        if (Off && Off->isZero()) os << "T\t" << fn << "\t" << typeIdString(T->getOperand(1), M) << "\n";
      }
      std::vector<std::pair<Instruction *, unsigned>> siteOf;
      unsigned site = 0, nind = 0;
      for (Instruction &I : instructions(F)) {
        if (!isSite(I)) continue;
        auto *CB = cast<CallBase>(&I);
        unsigned s = site++;
        siteOf.push_back({&I, s});
        if (Function *Callee = directCallee(CB)) {
          os << "C\t" << fn << "\t" << s << "\t" << nm(Callee->getName()) << "\n";
          StringRef callee = Callee->getName();
          for (const RegistryArg &R : kRegistries) {
            if (callee != R.callee || R.arg >= CB->arg_size()) continue;
            Value *A = CB->getArgOperand(R.arg)->stripPointerCasts();
            if (isa<ConstantPointerNull>(A)) continue;
            if (auto *Fn = dyn_cast<Function>(A)) os << "R\t" << R.registry << "\t" << nm(Fn->getName()) << "\n";
            else if (isa<Constant>(A) && !isa<GlobalValue>(A)) continue; // SIG_IGN, SIG_DFL, ...
            else if (auto *RC = dyn_cast<CallBase>(A); RC && directCallee(RC) && directCallee(RC)->getName() == callee)
              continue; // restoring a value this API returned (already registered)
            else if (auto *PA = dyn_cast<Argument>(A); PA && PA->getParent() == &F)
              // A forwarder registers its own parameter: covered by its
              // callers' records if it is itself a registration API.
              os << "R\t" << R.registry << "\t%" << PA->getArgNo() << "\t" << F.getName() << "\n";
            else os << "R\t" << R.registry << "\t*\n";
          }
          for (const SigactionApi &SA : kSigaction) {
            if (callee != SA.callee || SA.act >= CB->arg_size()) continue;
            sigactionRecords(CB->getArgOperand(SA.act), F, os, nm);
          }
        } else {
          ++nind;
          std::string sig = wasmSig(CB->getFunctionType(), DL);
          bool any = false;
          if (MDNode *N = CB->getMetadata("kandelo.icall")) {
            for (const MDOperand &O : N->operands()) {
              os << "S\t" << fn << "\t" << s << "\t" << sig << "\ticall\t" << typeIdString(O.get(), M) << "\n";
              any = true;
            }
          }
          if (MDNode *N = CB->getMetadata("kandelo.vcall")) {
            for (unsigned i = 0; i + 1 < N->getNumOperands(); i += 2) {
              auto *K = mdconst::dyn_extract<ConstantInt>(N->getOperand(i + 1));
              os << "S\t" << fn << "\t" << s << "\t" << sig << "\tvcall\t"
                 << typeIdString(N->getOperand(i), M) << "\t" << (K ? K->getSExtValue() : 0) << "\n";
              any = true;
            }
          }
          if (MDNode *O = CB->getMetadata("kandelo.origin"))
            os << "Y\t" << fn << "\t" << s << "\t" << cast<MDString>(O->getOperand(0))->getString() << "\n";
          else
            os << "Y\t" << fn << "\t" << s << "\tother\tno-origin\n";
          if (!any)
            os << "S\t" << fn << "\t" << s << "\t" << sig << "\tuntyped\t"
               << (F.getMetadata("kandelo.hadtests") ? "" : "fn-without-tests ")
               << describe(CB->getCalledOperand()) << "\n";
        }
        for (unsigned a = 0; a < CB->arg_size(); ++a) {
          Value *A = CB->getArgOperand(a);
          if (auto *K = dyn_cast<ConstantInt>(A); K && K->getBitWidth() <= 64)
            os << "A\t" << fn << "\t" << s << "\t" << a << "\tc\t" << K->getBitWidth() << "\t"
               << K->getZExtValue() << "\n";
          else if (auto *P = dyn_cast<Argument>(A); P && P->getParent() == &F)
            os << "A\t" << fn << "\t" << s << "\t" << a << "\tp\t" << P->getArgNo() << "\n";
        }
      }
      // Conditional reachability of call sites, one integer parameter at a time.
      if (site > 0) {
        for (Argument &P : F.args()) {
          if (!P.getType()->isIntegerTy() || P.getType()->getIntegerBitWidth() > 64) continue;
          std::vector<Use1> uses;
          castUses(&P, true, 0, uses);
          std::set<Value *> injective;
          std::set<uint64_t> cands;
          unsigned w = P.getType()->getIntegerBitWidth();
          auto addCand = [&](const APInt &k, bool) {
            APInt v = k.getBitWidth() >= w ? k.trunc(w) : k.zext(w);
            cands.insert(v.getZExtValue());
          };
          for (Use1 &U : uses) {
            if (U.injective) injective.insert(U.V);
            for (User *Us : U.V->users()) {
              if (auto *IC = dyn_cast<ICmpInst>(Us)) {
                auto *K = dyn_cast<ConstantInt>(IC->getOperand(1));
                if (!K || IC->getOperand(0) != U.V) continue;
                addCand(K->getValue(), U.injective);
                if (!IC->isEquality()) {
                  addCand(K->getValue() + 1, U.injective);
                  addCand(K->getValue() - 1, U.injective);
                }
              } else if (auto *Sw = dyn_cast<SwitchInst>(Us)) {
                if (Sw->getCondition() != U.V) continue;
                for (auto &Case : Sw->cases()) addCand(Case.getCaseValue()->getValue(), U.injective);
              }
            }
          }
          if (cands.empty() || cands.size() > 64) continue;
          // Record every candidate and `*` when any of them removes a site:
          // the analysis must tell "a candidate with every site reachable"
          // from "not a candidate".
          std::vector<std::pair<std::string, std::string>> rows;
          bool removes = false;
          auto add = [&](const std::set<BasicBlock *> &R, const std::string &val) {
            std::string list;
            unsigned n = 0;
            for (auto &[I, s] : siteOf)
              if (R.count(I->getParent())) { list += (n++ ? "," : "") + std::to_string(s); }
            removes |= n != site;
            rows.push_back({val, list});
          };
          for (uint64_t c : cands) {
            Constant *PV = ConstantInt::get(P.getType(), c);
            add(reachable(F, &P, PV, injective, cands, DL), std::to_string(c));
          }
          add(reachable(F, &P, nullptr, injective, cands, DL), "*");
          if (removes)
            for (auto &[val, list] : rows)
              os << "K\t" << fn << "\t" << P.getArgNo() << "\t" << w << "\t" << val << "\t" << list << "\n";
        }
      }
      os << "D\t" << fn << "\t" << nind << "\t" << site << "\n";
    }
    // Flow facts collected before optimization (TagPass).
    os << flowFacts()[&M];
    flowFacts().erase(&M);
    // Globals that only ever hold already-installed signal handlers.
    for (GlobalVariable &G : M.globals())
      if (oldactOnly(&G)) os << "O\t" << G.getName() << "\n";
    // Function-pointer conversions seen in the AST (KandeloFnCasts.cpp).
    os << kandeloAstFacts();
    kandeloAstFacts().clear();
    // Vtables: functions at (address point + K) of a class-typed vtable.
    for (GlobalVariable &G : M.globals()) {
      SmallVector<MDNode *, 4> types;
      G.getMetadata(LLVMContext::MD_type, types);
      if (types.empty() || !G.hasInitializer()) continue;
      std::vector<std::pair<uint64_t, Function *>> slots;
      std::function<void(Constant *, uint64_t)> walk = [&](Constant *C, uint64_t base) {
        if (auto *F = dyn_cast<Function>(C->stripPointerCasts())) { slots.push_back({base, F}); return; }
        if (auto *E = dyn_cast<DSOLocalEquivalent>(C)) { slots.push_back({base, E->getGlobalValue() ? dyn_cast<Function>(E->getGlobalValue()) : nullptr}); return; }
        if (auto *NC = dyn_cast<NoCFIValue>(C)) { slots.push_back({base, dyn_cast<Function>(NC->getGlobalValue())}); return; }
        if (isa<ConstantStruct>(C) || isa<ConstantArray>(C)) {
          Type *T = C->getType();
          for (unsigned i = 0; i < C->getNumOperands(); ++i) {
            uint64_t off = isa<StructType>(T)
                ? DL.getStructLayout(cast<StructType>(T))->getElementOffset(i)
                : i * DL.getTypeAllocSize(cast<ArrayType>(T)->getElementType());
            walk(cast<Constant>(C->getOperand(i)), base + off);
          }
        }
      };
      walk(G.getInitializer(), 0);
      for (MDNode *T : types) {
        auto *A = mdconst::dyn_extract<ConstantInt>(T->getOperand(0));
        if (!A) continue;
        uint64_t ap = A->getZExtValue();
        std::string cls = typeIdString(T->getOperand(1), M);
        // Member-function-pointer ids (".virtual") never match a virtual
        // call's class id; skip them to keep the section small.
        if (StringRef(cls).ends_with(".virtual")) continue;
        for (auto &[off, F] : slots)
          if (F && off >= ap) os << "V\t" << nm(F->getName()) << "\t" << cls << "\t" << (off - ap) << "\n";
      }
    }
    os.flush();
    localTypeIds().clear();
    kandeloModuleId().clear();
    kandeloOtherSanitizers() = true;
    // LLVM-sized programs can accumulate more than wasm-ld's 32-bit section
    // limit in these repetitive names/flow records. Preserve every fact in
    // a length-framed zlib chunk; the instrumenter decodes each chunk before
    // parsing the unchanged format-5 text. Small chunks retain their format.
    std::string stored;
    if (text.size() >= 1024 * 1024) {
      if (!compression::zlib::isAvailable())
        report_fatal_error("kandelo-calltypes: LLVM requires zlib support for large compiler-facts chunks");
      SmallVector<uint8_t, 0> compressed;
      compression::zlib::compress(
          ArrayRef<uint8_t>(reinterpret_cast<const uint8_t *>(text.data()), text.size()),
          compressed);
      stored.assign("KCTZ\0\0\0\1", 8);
      stored.resize(24);
      support::endian::write64le(stored.data() + 8, text.size());
      support::endian::write64le(stored.data() + 16, compressed.size());
      stored.append(reinterpret_cast<const char *>(compressed.data()), compressed.size());
    } else stored = text;
    // The object's `kandelo.calltypes` custom section (see the header).
    LLVMContext &Ctx = M.getContext();
    M.getOrInsertNamedMetadata("wasm.custom_sections")
        ->addOperand(MDNode::get(Ctx, {MDString::get(Ctx, kSectionName), MDString::get(Ctx, stored)}));
    if (!OutPath.empty()) {
      std::error_code EC;
      raw_fd_ostream file(OutPath, EC, sys::fs::OF_Text);
      if (EC) report_fatal_error(Twine("kandelo-calltypes: cannot write ") + OutPath + ": " + EC.message());
      file << text;
    }
    // Only named metadata was added; no analysis is invalidated.
    return PreservedAnalyses::all();
  }
};

} // namespace

extern "C" LLVM_ATTRIBUTE_WEAK PassPluginLibraryInfo llvmGetPassPluginInfo() {
  return {LLVM_PLUGIN_API_VERSION, "KandeloCallTypes", "0.3", [](PassBuilder &PB) {
            PB.registerPipelineStartEPCallback(
                [](ModulePassManager &MPM, OptimizationLevel) { MPM.addPass(TagPass()); });
            PB.registerOptimizerLastEPCallback(
                [](ModulePassManager &MPM, OptimizationLevel, ThinOrFullLTOPhase) { MPM.addPass(EmitPass()); });
          }};
}
