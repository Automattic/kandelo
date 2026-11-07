#include "host-transfer-order.h"
#include <array>
#include <cassert>
#include <cstdlib>
#include <iostream>
#include <new>
#include <type_traits>
using kandelo::clone::HostOrder;
using Kind=HostOrder::Kind;
static_assert(!std::is_copy_constructible_v<HostOrder> && !std::is_move_constructible_v<HostOrder>);
static bool noAlloc=false;
void* operator new(std::size_t size){if(noAlloc)throw std::bad_alloc();if(void* p=std::malloc(size?size:1))return p;throw std::bad_alloc();}
void operator delete(void* p) noexcept{std::free(p);}
void operator delete(void* p,std::size_t) noexcept{std::free(p);}
int main(){unsigned groups=0;
 {
  HostOrder owner;owner.Append(Kind::Native,0);owner.Append(Kind::Native,2);owner.Append(Kind::JavaScript,0);owner.Append(Kind::JavaScript,1);
  uint32_t slots[]={0,2};assert(owner.Prepare(3,2));assert(owner.MatchesNativeSlots(slots,2));
  std::array<unsigned,4> order{};size_t used=0;auto create=[&](uint32_t i){order[used++]=100+i;return true;};
  assert(owner.BeforeNative(0,create));order[used++]=0;assert(owner.CommitNative(0));
  assert(owner.BeforeNative(2,create));order[used++]=2;assert(owner.CommitNative(2));assert(owner.Finish(create));
  assert((order==std::array<unsigned,4>{0,2,100,101}));groups++;
 }
 {
  HostOrder owner;owner.Append(Kind::JavaScript,1);owner.Append(Kind::Native,0);owner.Append(Kind::JavaScript,0);owner.Append(Kind::Native,2);owner.Append(Kind::JavaScript,2);
  uint32_t slots[]={0,2};assert(owner.Prepare(3,3));assert(owner.MatchesNativeSlots(slots,2));
  std::array<unsigned,5> order{};size_t used=0;auto create=[&](uint32_t i){order[used++]=100+i;return true;};
  noAlloc=true;assert(owner.BeforeNative(0,create));order[used++]=0;assert(owner.CommitNative(0));
  assert(owner.BeforeNative(2,create));order[used++]=2;assert(owner.CommitNative(2));assert(owner.Finish(create));noAlloc=false;
  assert((order==std::array<unsigned,5>{101,0,100,2,102}));assert(owner.Finish(create));assert(used==5);groups++;
 }
 {
  for(unsigned kind=0;kind<7;++kind){HostOrder owner;
   switch(kind){case 0:owner.Append(Kind(4),0);break;case 1:owner.Append(Kind::Native,1);break;case 2:owner.Append(Kind::Native,0);owner.Append(Kind::Native,0);break;case 3:owner.Append(Kind::Native,1);owner.Append(Kind::Native,0);break;case 4:owner.Append(Kind::JavaScript,1);break;case 5:owner.Append(Kind::JavaScript,0);owner.Append(Kind::JavaScript,0);break;case 6:break;}
   assert(!owner.Prepare(kind==3?2:1,kind>=4?1:0));
  }groups++;
 }
 {
  HostOrder owner;owner.Append(Kind::Native,0);assert(owner.Prepare(2,0));uint32_t actual[]={1};assert(!owner.MatchesNativeSlots(actual,1));
  bool called=false;assert(!owner.BeforeNative(0,[&](uint32_t){called=true;return true;}));assert(!called);groups++;
 }
 {
  HostOrder owner;owner.Append(Kind::JavaScript,0);owner.Append(Kind::Native,0);assert(owner.Prepare(1,1));
  unsigned calls=0;assert(!owner.BeforeNative(0,[&](uint32_t){++calls;return false;}));
  assert(!owner.BeforeNative(0,[&](uint32_t){++calls;return true;}));assert(!owner.CommitNative(0));assert(calls==1);groups++;
 }
 {
  HostOrder owner;owner.Append(Kind::JavaScript,0);owner.Append(Kind::Native,0);assert(owner.Prepare(1,1));
  unsigned calls=0;assert(owner.BeforeNative(0,[&](uint32_t){++calls;return true;}));
  // The actual native callback failed: no CommitNative is allowed. A tail
  // constructor cannot run, and destruction of this reader owns rollback.
  assert(!owner.Finish([&](uint32_t){++calls;return true;}));assert(calls==1);groups++;
 }
 {
  HostOrder owner;owner.Append(Kind::JavaScript,0);assert(owner.Prepare(0,1));assert(!owner.Append(Kind::JavaScript,0));
  bool called=false;assert(!owner.Finish([&](uint32_t){called=true;return true;}));assert(!called);groups++;
 }
 {
  HostOrder owner;assert(owner.Prepare(0,0));assert(owner.MatchesNativeSlots(nullptr,0));bool called=false;
  noAlloc=true;assert(owner.Finish([&](uint32_t){called=true;return true;}));noAlloc=false;assert(!called);groups++;
 }
 {
  HostOrder owner;owner.Append(Kind::JavaScript,0);bool oom=false;noAlloc=true;
  try{owner.Prepare(0,1);}catch(const std::bad_alloc&){oom=true;}noAlloc=false;assert(oom);
  bool called=false;assert(!owner.Finish([&](uint32_t){called=true;return true;}));assert(!called);groups++;
 }
 std::cout<<"{\"groups\":"<<groups<<",\"phaseTransitionsAllocate\":false,\"scope\":\"Actual portable metadata/receiver phase owner, not JSAPI, generic transfer support or guest conformance\"}\n";
}
