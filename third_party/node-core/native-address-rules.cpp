/* Actual native SocketAddress/BlockList state. Messaging of shared owners is
 * still a separate serializer/worker integration prerequisite. */
#include "kandelo-node-address-rules.h"
namespace {
struct KandeloAddressOwner {
  std::shared_ptr<kandelo::node_address::Address> address;
  std::shared_ptr<kandelo::node_address::BlockList> rules;
};
static void KandeloAddressFinalize(JS::GCContext*, JSObject* object) {
  const auto slot=JS::GetReservedSlot(object,0);
  if(!slot.isUndefined())delete static_cast<KandeloAddressOwner*>(slot.toPrivate());
}
static const JSClassOps KandeloAddressClassOps={nullptr,nullptr,nullptr,nullptr,nullptr,nullptr,
  KandeloAddressFinalize,nullptr,nullptr,nullptr};
static const JSClass KandeloAddressClass={"SocketAddress",
  JSCLASS_HAS_RESERVED_SLOTS(1)|JSCLASS_FOREGROUND_FINALIZE,&KandeloAddressClassOps};
static const JSClass KandeloBlockListClass={"BlockList",
  JSCLASS_HAS_RESERVED_SLOTS(1)|JSCLASS_FOREGROUND_FINALIZE,&KandeloAddressClassOps};
static KandeloAddressOwner* KandeloAddressState(HandleValue value,bool address) {
  if(!value.isObject())return nullptr;
  JSObject* object=js::CheckedUnwrapStatic(&value.toObject());
  if(!object || JS::GetClass(object)!=(address?&KandeloAddressClass:&KandeloBlockListClass))return nullptr;
  const auto slot=JS::GetReservedSlot(object,0);
  if(slot.isUndefined())return nullptr;
  return static_cast<KandeloAddressOwner*>(slot.toPrivate());
}
static bool KandeloAddressPacket(JSContext* cx,const char* error,HandleValue value,MutableHandleValue out) {
  RootedObject result(cx,JS_NewObjectWithGivenProto(cx,nullptr,nullptr));
  if(!result || !JS_DefineProperty(cx,result,"value",value,JSPROP_ENUMERATE))return false;
  if(error) {
    RootedString string(cx,JS_NewStringCopyZ(cx,error));
    RootedValue code(cx);if(!string)return false;code.setString(string);
    if(!JS_DefineProperty(cx,result,"error",code,JSPROP_ENUMERATE))return false;
  }
  out.setObject(*result);return true;
}
static bool KandeloAddressText(JSContext* cx,const std::string& text,MutableHandleValue out) {
  RootedString string(cx,JS_NewStringCopyN(cx,text.data(),text.size()));
  if(!string)return false;out.setString(string);return true;
}
static bool KandeloNativeAddressRules(JSContext* cx,unsigned argc,Value* vp) {
  CallArgs args=CallArgsFromVp(argc,vp);
  if(!args.get(0).isString()){JS_ReportErrorASCII(cx,"Address operation requires a name");return false;}
  RootedString operationName(cx,args[0].toString());
  JS::UniqueChars operation=JS_EncodeStringToUTF8(cx,operationName);if(!operation)return false;
  const char* name=operation.get();RootedValue value(cx,UndefinedValue());const char* error=nullptr;
  if(std::strcmp(name,"families")==0) {
    RootedObject list(cx,JS::NewArrayObject(cx,2));if(!list)return false;
    RootedValue v4(cx,Int32Value(AF_INET)),v6(cx,Int32Value(AF_INET6));
    if(!JS_SetElement(cx,list,0,v4)||!JS_SetElement(cx,list,1,v6))return false;
    value.setObject(*list);
  } else if(std::strcmp(name,"createAddress")==0 || std::strcmp(name,"createList")==0) {
    if(!args.get(1).isObject()){JS_ReportErrorASCII(cx,"Address owner requires a prototype");return false;}
    const bool address=std::strcmp(name,"createAddress")==0;
    auto owner=std::make_unique<KandeloAddressOwner>();
    if(address) {
      if(!args.get(2).isString()||!args.get(3).isInt32()||!args.get(4).isInt32()||!args.get(5).isInt32()) {
        JS_ReportErrorASCII(cx,"Address requires checked string/int32 arguments");return false;
      }
      // Public JS passes flowlabel | 0; the pinned native constructor CHECKs
      // IsUint32 before parsing the address, even for the IPv4 family.
      if(args[5].toInt32()<0)std::abort();
      RootedString addressText(cx,args[2].toString());
      JS::UniqueChars text=JS_EncodeStringToUTF8(cx,addressText);if(!text)return false;
      owner->address=std::make_shared<kandelo::node_address::Address>();
      if(!kandelo::node_address::Address::Parse(args[4].toInt32(),text.get(),uint16_t(args[3].toInt32()),owner->address.get()))error="ERR_INVALID_ADDRESS";
      else owner->address->SetFlowLabel(uint32_t(args[5].toInt32()));
    } else owner->rules=std::make_shared<kandelo::node_address::BlockList>();
    if(!error) {
      RootedObject prototype(cx,&args[1].toObject());
      RootedObject object(cx,JS_NewObjectWithGivenProto(cx,address?&KandeloAddressClass:&KandeloBlockListClass,prototype));
      if(!object)return false;
      JS::SetReservedSlot(object,0,PrivateValue(owner.release()));value.setObject(*object);
    }
  } else {
    const bool address=std::strcmp(name,"detail")==0 || std::strcmp(name,"flowlabel")==0;
    KandeloAddressOwner* owner=KandeloAddressState(args.get(1),address);
    if(!owner)error="ERR_INVALID_THIS";
    else if(address) {
      const auto& a=*owner->address;
      if(std::strcmp(name,"flowlabel")==0)value.setNumber(a.flow);
      else {
        RootedObject list(cx,JS::NewArrayObject(cx,4));RootedValue field(cx);
        if(!list || !KandeloAddressText(cx,a.text(),&field) || !JS_SetElement(cx,list,0,field))return false;
        field.setInt32(a.port);if(!JS_SetElement(cx,list,1,field))return false;
        field.setInt32(a.family);if(!JS_SetElement(cx,list,2,field))return false;
        field.setNumber(a.flow);if(!JS_SetElement(cx,list,3,field))return false;
        value.setObject(*list);
      }
    } else if(std::strcmp(name,"clear")==0)owner->rules->Clear();
    else if(std::strcmp(name,"size")==0)value.setNumber(double(owner->rules->Size()));
    else if(std::strcmp(name,"rules")==0) {
      const auto rules=owner->rules->Rules();RootedObject list(cx,JS::NewArrayObject(cx,rules.size()));if(!list)return false;
      for(uint32_t i=0;i<rules.size();i++){RootedValue text(cx);if(!KandeloAddressText(cx,rules[i],&text)||!JS_SetElement(cx,list,i,text))return false;}
      value.setObject(*list);
    } else if(std::strcmp(name,"checkString")==0) {
      if(!args.get(2).isString()||!args.get(3).isInt32()){JS_ReportErrorASCII(cx,"Address check requires string/family");return false;}
      RootedString addressText(cx,args[2].toString());
      JS::UniqueChars text=JS_EncodeStringToUTF8(cx,addressText);if(!text)return false;
      kandelo::node_address::Address a;value.setBoolean(kandelo::node_address::Address::Parse(args[3].toInt32(),text.get(),0,&a) && owner->rules->Check(a));
    } else if(std::strcmp(name,"addAddresses")==0) {
      if(!args.get(2).isObject()){JS_ReportErrorASCII(cx,"Address batch requires array");return false;}
      RootedObject list(cx,&args[2].toObject());uint32_t length;if(!JS::GetArrayLength(cx,list,&length))return false;
      std::vector<kandelo::node_address::Address> addresses;addresses.reserve(length);
      for(uint32_t i=0;i<length;i++) {
        RootedValue item(cx);if(!JS_GetElement(cx,list,i,&item))return false;
        auto* state=KandeloAddressState(item,true);if(!state){error="ERR_INVALID_THIS";break;}
        addresses.push_back(*state->address);
      }
      if(!error)owner->rules->AddAddresses(addresses);
    } else {
      auto* first=KandeloAddressState(args.get(2),true);
      if(!first)error="ERR_INVALID_THIS";
      else if(std::strcmp(name,"addAddress")==0)owner->rules->AddAddress(*first->address);
      else if(std::strcmp(name,"removeAddress")==0)owner->rules->RemoveAddress(*first->address);
      else if(std::strcmp(name,"check")==0)value.setBoolean(owner->rules->Check(*first->address));
      else if(std::strcmp(name,"addRange")==0 || std::strcmp(name,"removeRange")==0) {
        auto* second=KandeloAddressState(args.get(3),true);
        if(!second)error="ERR_INVALID_THIS";
        else if(std::strcmp(name,"addRange")==0)value.setBoolean(owner->rules->AddRange(*first->address,*second->address));
        else owner->rules->RemoveRange(*first->address,*second->address);
      } else if(std::strcmp(name,"addSubnet")==0 || std::strcmp(name,"removeSubnet")==0) {
        if(!args.get(3).isInt32()){JS_ReportErrorASCII(cx,"Subnet prefix requires int32");return false;}
        const int prefix=args[3].toInt32();
        const int maximum=first->address->family==AF_INET?32:128;
        if(prefix<0 || prefix>maximum){error="ERR_OUT_OF_RANGE";value.setInt32(maximum);}
        else if(std::strcmp(name,"addSubnet")==0)value.setBoolean(owner->rules->AddSubnet(*first->address,prefix));
        else owner->rules->RemoveSubnet(*first->address,prefix);
      } else {JS_ReportErrorASCII(cx,"Unknown address/rule operation");return false;}
    }
  }
  return KandeloAddressPacket(cx,error,value,args.rval());
}
} // namespace
