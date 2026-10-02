// KandeloCallTypes: an out-of-tree LLVM pass plugin (clang -fpass-plugin).
//
// Research tool for fork-path precision (docs/plans/*-fork-path-precision.md).
// It gives the fork-path analysis source-level facts about calls without
// changing the code that ships.
//
// 1. Pipeline start (before any optimization): clang has emitted CFI type
//    tests (-Xclang -fsanitize=cfi-icall,cfi-vcall). For every indirect call
//    guarded by a test, attach the test's type id to the call as metadata
//    (!kandelo.icall / !kandelo.vcall), then delete the test so the optimizer
//    sees the same IR as an ordinary build. Metadata on calls survives
//    inlining and cloning.
// 2. Optimizer last (just before code generation): write a side file
//    describing every remaining call, every function's type ids, every
//    vtable slot, constant and pass-through call arguments, and which call
//    sites stay reachable when one integer parameter has a known value.
//
// Side file path: -mllvm -kandelo-calltypes-out=<path>. Format v2 (TSV,
// demangled names matching the wasm name section):
//   #kandelo-calltypes	2
//   M	module-id
//   F	fn	nparams	linkage(E|I)	addr-taken(0|1)
//   T	fn	typeid                       function type id (offset 0 only)
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
#include "llvm/Support/FileSystem.h"
#include "llvm/Support/raw_ostream.h"
#include <functional>
#include <map>
#include <set>

using namespace llvm;

static cl::opt<std::string> OutPath("kandelo-calltypes-out", cl::init(""),
                                    cl::desc("Write the Kandelo call-type side file here"));

namespace {

std::string typeIdString(Metadata *MD, const Module &M) {
  if (auto *S = dyn_cast<MDString>(MD)) return S->getString().str();
  // Distinct (internal-linkage) type ids are unique per module.
  std::string s;
  raw_string_ostream os(s);
  os << "L:" << M.getModuleIdentifier() << ":" << (const void *)MD;
  return s;
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

struct TagPass : PassInfoMixin<TagPass> {
  PreservedAnalyses run(Module &M, ModuleAnalysisManager &) {
    LLVMContext &Ctx = M.getContext();
    bool changed = false;
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
      for (CallInst *T : dead) {
        T->replaceAllUsesWith(ConstantInt::getTrue(Ctx));
        T->eraseFromParent();
      }
      changed = true;
    }
    return changed ? PreservedAnalyses::none() : PreservedAnalyses::all();
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
};

// The function a call targets directly, looking through aliases.
Function *directCallee(CallBase *CB) {
  if (Function *F = CB->getCalledFunction()) return F;
  Value *V = CB->getCalledOperand()->stripPointerCasts();
  if (auto *GA = dyn_cast<GlobalAlias>(V)) return dyn_cast_or_null<Function>(GA->getAliaseeObject());
  return dyn_cast<Function>(V);
}

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

struct EmitPass : PassInfoMixin<EmitPass> {
  PreservedAnalyses run(Module &M, ModuleAnalysisManager &) {
    if (OutPath.empty()) return PreservedAnalyses::all();
    std::error_code EC;
    raw_fd_ostream os(OutPath, EC, sys::fs::OF_Text);
    if (EC) report_fatal_error(Twine("kandelo-calltypes: cannot write ") + OutPath + ": " + EC.message());
    const DataLayout &DL = M.getDataLayout();
    auto nm = [](StringRef n) { return demangle(n.str()); };
    os << "#kandelo-calltypes\t2\n";
    os << "M\t" << M.getModuleIdentifier() << "\n";
    // Registration APIs whose address escapes (called indirectly or stored)
    // make their registry unknown.
    for (const RegistryArg &R : kRegistries) {
      Function *F = M.getFunction(R.callee);
      if (!F) continue;
      for (const Use &U : F->uses()) {
        auto *CB = dyn_cast<CallBase>(U.getUser());
        if (CB && CB->isCallee(&U)) continue;
        os << "R\t" << R.registry << "\t?\n";
        break;
      }
    }
    for (Function &F : M) {
      if (F.isDeclaration()) continue;
      std::string fn = nm(F.getName());
      os << "F\t" << fn << "\t" << F.arg_size() << "\t" << (F.hasLocalLinkage() ? "I" : "E") << "\t"
         << (F.hasAddressTaken() ? 1 : 0) << "\n";
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
            else if (auto *PA = dyn_cast<Argument>(A); PA && PA->getParent() == &F)
              // A forwarder registers its own parameter: covered by its
              // callers' records if it is itself a registration API.
              os << "R\t" << R.registry << "\t%" << PA->getArgNo() << "\t" << F.getName() << "\n";
            else os << "R\t" << R.registry << "\t*\n";
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
        // call's class id; skip them to keep the side file small.
        if (StringRef(cls).ends_with(".virtual")) continue;
        for (auto &[off, F] : slots)
          if (F && off >= ap) os << "V\t" << nm(F->getName()) << "\t" << cls << "\t" << (off - ap) << "\n";
      }
    }
    return PreservedAnalyses::all();
  }
};

} // namespace

extern "C" LLVM_ATTRIBUTE_WEAK PassPluginLibraryInfo llvmGetPassPluginInfo() {
  return {LLVM_PLUGIN_API_VERSION, "KandeloCallTypes", "0.2", [](PassBuilder &PB) {
            PB.registerPipelineStartEPCallback(
                [](ModulePassManager &MPM, OptimizationLevel) { MPM.addPass(TagPass()); });
            PB.registerOptimizerLastEPCallback(
                [](ModulePassManager &MPM, OptimizationLevel, ThinOrFullLTOPhase) { MPM.addPass(EmitPass()); });
          }};
}
